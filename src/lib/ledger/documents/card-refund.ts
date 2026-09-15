import type { PoolClient } from "pg";

import { loadAccountMapByKeys } from "../accounts";
import { LedgerError } from "../types";

import { createJournalEntry, getJournalEntry, postJournalEntry, voidJournalEntry } from "./journal-entry";
import type { PostGlDocumentResult } from "./journal-entry";

/**
 * deposit-surcharge-qb-20260915 — refund de TARJETA liquidado por el procesador.
 *
 * BAMS no emite un cheque: NETEA el refund dentro del lote del día siguiente
 * (el crédito del banco = Σ cobros brutos − Σ refunds). El documento contable
 * correcto es un asiento **Dr Accounts Receivable (cliente) / Cr Undeposited
 * Funds** por el principal devuelto — exactamente lo que QuickBooks muestra en
 * "Payments to Deposit" como ítem negativo y acepta como línea del Deposit
 * (`PaymentTxnID` = TxnID del JournalEntry). Este QuickBooks NO acepta
 * `ARRefundCreditCardAddRq` (0x80040400 en 7.0/10.0/11.0/13.0, sondeado el
 * 09/15/2026), así que el JE es el carril: `gl_journal_entry` JE-#### con
 * entidad cliente → JournalEntryAdd (lane gl_document_add), TxnVoid al anular.
 *
 * El refund devuelve SÓLO el principal (`store-pos/app/api/bams/refund`:
 * `refund_amount ?? payment.amount`) — el surcharge cobrado no vuelve.
 *
 * Identidad: el cobro (`customer_payment`, status refunded/partial_refunded).
 * En `customer_payment.qb` quedan `refund_settlement='processor_batch'` y
 * `refund_journal_entry_id`; Record Deposits ofrece el refund como línea
 * NEGATIVA y el DepositAdd referencia el TxnID del JE.
 */

export type CardRefundPayment = {
  id: string;
  display_id: number | null;
  customer_id: string;
  customer_name: string;
  reference: string | null;
  type: string;
  status: string;
  refund_cents: bigint;
  qb: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export async function loadCardRefundPayment(
  client: PoolClient,
  paymentId: string
): Promise<CardRefundPayment> {
  const { rows } = await client.query<{
    id: string;
    display_id: number | null;
    customer_id: string;
    customer_name: string;
    reference: string | null;
    type: string;
    status: string;
    amount: string;
    refund_amount: string | null;
    qb: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT mp.id, mp.display_id, mp.customer_id, mp.reference, mp.type, mp.status, mp.amount::text,
            mp.metadata->>'refund_amount' AS refund_amount, mp.qb, mp.metadata,
            COALESCE(NULLIF(c.company_name,''),NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,c.id) AS customer_name
       FROM customer_payment mp JOIN customer c ON c.id = mp.customer_id
      WHERE mp.id = $1 AND mp.deleted_at IS NULL`,
    [paymentId]
  );
  const row = rows[0];
  if (!row) throw new LedgerError("GL_DOCUMENT_NOT_FOUND", { paymentId });
  const cents = BigInt((row.refund_amount ?? row.amount).split(".")[0]!);
  return {
    id: row.id,
    display_id: row.display_id,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    reference: row.reference,
    type: row.type,
    status: row.status,
    refund_cents: cents,
    qb: row.qb ?? {},
    metadata: row.metadata ?? {},
  };
}

export interface CardRefundJournalResult {
  journal_entry_id: string;
  number: string;
  post: PostGlDocumentResult;
}

/**
 * Registra el refund de tarjeta como JE-#### (Dr AR cliente / Cr UF) y lo
 * postea (→ JournalEntryAdd). Idempotente: si el cobro ya tiene
 * `refund_journal_entry_id` devuelve ese JE sin crear otro. Falla cerrado si
 * el cobro no está reembolsado, si ya viajó a QuickBooks como cheque
 * (`check_txn_id`), o si el monto es 0.
 */
export async function recordCardRefundJournal(
  client: PoolClient,
  paymentId: string,
  day: string,
  actorId: string
): Promise<CardRefundJournalResult> {
  const payment = await loadCardRefundPayment(client, paymentId);
  if (!["refunded", "partial_refunded"].includes(payment.status))
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "payment_not_refunded", status: payment.status });
  if (payment.refund_cents <= 0n)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "refund_amount_not_positive" });
  if (payment.qb.check_txn_id)
    throw new LedgerError("GL_SOURCE_INVALID", { reason: "refund_already_a_check", check_txn_id: payment.qb.check_txn_id });

  const existingId = typeof payment.qb.refund_journal_entry_id === "string" ? payment.qb.refund_journal_entry_id : null;
  if (existingId) {
    const existing = await getJournalEntry(client, existingId);
    if (existing && existing.status !== "voided") {
      const post = await postJournalEntry(client, existingId, actorId);
      return { journal_entry_id: existingId, number: existing.number, post };
    }
  }

  const map = await loadAccountMapByKeys(client, ["accounts_receivable", "undeposited_funds"]);
  const ar = map.accounts_receivable!;
  const uf = map.undeposited_funds!;
  const label = payment.reference ?? `PAY-${payment.display_id ?? payment.id}`;
  const je = await createJournalEntry(
    client,
    {
      day,
      memo: `Card refund ${label} · ${payment.customer_name} (processor batch)`,
      lines: [
        {
          account_list_id: ar.id,
          debit_cents: payment.refund_cents,
          credit_cents: 0n,
          memo: `Refund ${label}`,
          entity_type: "customer",
          entity_id: payment.customer_id,
          entity_name: payment.customer_name,
        },
        {
          account_list_id: uf.id,
          debit_cents: 0n,
          credit_cents: payment.refund_cents,
          memo: `Refund ${label} — netted by the processor`,
        },
      ],
    },
    actorId
  );
  const post = await postJournalEntry(client, je.id, actorId);
  await client.query(
    `UPDATE customer_payment SET qb = COALESCE(qb,'{}'::jsonb) || $2::jsonb, updated_at = now() WHERE id = $1`,
    [
      paymentId,
      JSON.stringify({
        status: "yes",
        refund_settlement: "processor_batch",
        refund_journal_entry_id: je.id,
        refund_journal_number: je.number,
        refund_txn_date: day,
      }),
    ]
  );
  await client.query(
    `UPDATE customer_payment SET metadata = COALESCE(metadata,'{}'::jsonb) || $2::jsonb WHERE id = $1`,
    [paymentId, JSON.stringify({ refund_txn_date: day, refund_settlement: "processor_batch" })]
  );
  return { journal_entry_id: je.id, number: je.number, post };
}

/** Anula el JE del refund (TxnVoid en QuickBooks por el lane) y limpia la marca del cobro. */
export async function voidCardRefundJournal(
  client: PoolClient,
  paymentId: string,
  reason: string,
  actorId: string
): Promise<void> {
  const payment = await loadCardRefundPayment(client, paymentId);
  const id = typeof payment.qb.refund_journal_entry_id === "string" ? payment.qb.refund_journal_entry_id : null;
  if (!id) return;
  await voidJournalEntry(client, id, reason, actorId);
  await client.query(
    `UPDATE customer_payment SET qb = (COALESCE(qb,'{}'::jsonb) - 'refund_journal_entry_id' - 'refund_journal_number') || '{"refund_settlement":"voided"}'::jsonb, updated_at = now() WHERE id = $1`,
    [paymentId]
  );
}
