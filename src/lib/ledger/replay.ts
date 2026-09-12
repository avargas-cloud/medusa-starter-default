import type { PoolClient } from "pg";

import { postCreditMemo, reverseCreditMemo } from "./documents/credit-memo";
import { postInvoice, reverseInvoice } from "./documents/invoice";
import { postCustomerPayment, reverseCustomerPayment } from "./documents/customer-payment";
import {
  postRoundingAdjustment,
  reverseRoundingAdjustment,
} from "./documents/rounding";
import { postReceipt, reverseReceipt } from "./documents/receipt";
import { postVendorBill, reverseVendorBill } from "./documents/vendor-bill";
import { postVendorCredit, reverseVendorCredit } from "./documents/vendor-credit";
import { postBillPayment, reverseBillPayment } from "./documents/bill-payment";
import { LedgerError, LedgerSourceKind } from "./types";

export interface ReplayOptions {
  /** YYYY-MM-DD, en la fecha contable del documento (ET). */
  from: string;
  to: string;
  kinds?: LedgerSourceKind[];
  apply: boolean;
  limit?: number;
}

export interface ReplayCounts {
  posted: number;
  already_posted: number;
  reversed: number;
  blocked: number;
}

export interface ReplayBlock {
  source_kind: LedgerSourceKind;
  source_id: string;
  code: string;
}

export interface ReplayReport {
  apply: boolean;
  counts: Record<LedgerSourceKind, ReplayCounts>;
  blocked: ReplayBlock[];
}

/**
 * `opening_balance` NUNCA se replaya (§2: se postea a mano una vez, en
 * `2026-04-13`, fuera de la ventana `[from,to]` del replay) — por eso queda
 * afuera de `ALL_KINDS`, el default de `options.kinds`. `HANDLERS` y
 * `candidates` igual necesitan una rama explícita para ese kind: el tipo es
 * `Record<LedgerSourceKind, …>`, así que sin ella no compila.
 */
const ALL_KINDS: LedgerSourceKind[] = [
  "pos_invoice",
  "pos_credit_memo",
  "customer_payment",
  "rounding_adjustment",
  "po_receipt",
  "vendor_bill",
  "vendor_credit",
  "vendor_bill_payment",
];

/** §6: mismas reglas de terminalidad que el reconciler. */
const REPLAY_ACTOR = "ledger-reconciler";
const BLOCK_REPORT_CAP = 200;

function emptyCounts(): ReplayCounts {
  return { posted: 0, already_posted: 0, reversed: 0, blocked: 0 };
}

type Candidate = { id: string; terminal: "post" | "reverse" };

async function candidates(
  client: PoolClient,
  kind: LedgerSourceKind,
  from: string,
  to: string,
  limit: number
): Promise<Candidate[]> {
  if (kind === "opening_balance") return [];
  if (kind === "pos_invoice") {
    const { rows } = await client.query<Candidate>(
      `SELECT id, CASE WHEN status = 'voided' THEN 'reverse' ELSE 'post' END AS terminal
       FROM pos_invoice
       WHERE deleted_at IS NULL
         AND COALESCE(voided_at, issued_at)::date BETWEEN $1::date AND $2::date
         AND status IN ('issued','partial','paid','partially_refunded','refunded','voided')
       ORDER BY id LIMIT $3`,
      [from, to, limitParam(limit)]
    );
    return rows;
  }
  if (kind === "pos_credit_memo") {
    const { rows } = await client.query<Candidate>(
      `SELECT id, CASE WHEN status = 'voided' THEN 'reverse' ELSE 'post' END AS terminal
       FROM pos_credit_memo
       WHERE deleted_at IS NULL
         AND COALESCE(voided_at, completed_at)::date BETWEEN $1::date AND $2::date
         AND status IN ('completed','voided')
         AND COALESCE(metadata->>'is_internal_adjustment', 'false') <> 'true'
         AND COALESCE(metadata->>'never_sync_to_qb', 'false') <> 'true'
       ORDER BY id LIMIT $3`,
      [from, to, limitParam(limit)]
    );
    return rows;
  }
  if (kind === "customer_payment") {
    const { rows } = await client.query<Candidate>(
      `SELECT id, CASE WHEN status = 'voided' THEN 'reverse' ELSE 'post' END AS terminal
       FROM customer_payment
       WHERE deleted_at IS NULL AND type IN ('payment','refund') AND amount > 0
         AND received_at::date BETWEEN $1::date AND $2::date
       ORDER BY id LIMIT $3`,
      [from, to, limitParam(limit)]
    );
    return rows;
  }
  if (kind === "rounding_adjustment") {
    const { rows } = await client.query<Candidate>(
      `SELECT id, CASE WHEN voided_at IS NOT NULL THEN 'reverse' ELSE 'post' END AS terminal
       FROM pos_rounding_adjustment
       WHERE deleted_at IS NULL
         AND COALESCE(voided_at, created_at)::date BETWEEN $1::date AND $2::date
       ORDER BY id LIMIT $3`,
      [from, to, limitParam(limit)]
    );
    return rows;
  }
  if (kind === "po_receipt") {
    // gl-purchases-v2 §5: SIN filtro `deleted_at IS NULL` — un receipt
    // borrado (soft-delete) tiene que seguir candidateándose para su reversa.
    const { rows } = await client.query<Candidate>(
      `SELECT id, CASE WHEN voided_at IS NOT NULL OR deleted_at IS NOT NULL THEN 'reverse' ELSE 'post' END AS terminal
       FROM purchase_order_receipt
       WHERE COALESCE(voided_at, deleted_at, updated_at, received_at)::date BETWEEN $1::date AND $2::date
         AND status IN ('applied','synced','voided')
       ORDER BY id LIMIT $3`,
      [from, to, limitParam(limit)]
    );
    return rows;
  }
  if (kind === "vendor_bill") {
    const { rows } = await client.query<Candidate>(
      `SELECT id, CASE WHEN status IN ('cancelled','voided') THEN 'reverse' ELSE 'post' END AS terminal
       FROM vendor_bill
       WHERE deleted_at IS NULL
         AND COALESCE(document_date, confirmed_at, updated_at)::date BETWEEN $1::date AND $2::date
         AND status IN ('confirmed','synced','cancelled','voided')
       ORDER BY id LIMIT $3`,
      [from, to, limitParam(limit)]
    );
    return rows;
  }
  if (kind === "vendor_credit") {
    const { rows } = await client.query<Candidate>(
      `SELECT id, CASE WHEN status = 'voided' THEN 'reverse' ELSE 'post' END AS terminal
       FROM vendor_credit
       WHERE deleted_at IS NULL
         AND COALESCE(voided_at, credit_date)::date BETWEEN $1::date AND $2::date
         AND status IN ('posted','voided')
       ORDER BY id LIMIT $3`,
      [from, to, limitParam(limit)]
    );
    return rows;
  }
  // vendor_bill_payment
  const { rows } = await client.query<Candidate>(
    `SELECT id, CASE WHEN status = 'voided' THEN 'reverse' ELSE 'post' END AS terminal
     FROM vendor_bill_payment
     WHERE deleted_at IS NULL
       AND COALESCE(voided_at, payment_date)::date BETWEEN $1::date AND $2::date
       AND status IN ('posted','voided')
     ORDER BY id LIMIT $3`,
    [from, to, limitParam(limit)]
  );
  return rows;
}

/** `limit<=0` es "sin tope" — `LIMIT NULL` en Postgres es equivalente a omitir el LIMIT. */
function limitParam(limit: number): number | null {
  return limit > 0 ? limit : null;
}

type Handler = {
  post: (client: PoolClient, id: string, actor: string) => Promise<{ status: string }>;
  reverse: (client: PoolClient, id: string, actor: string) => Promise<{ status: string }>;
};

/** `opening_balance` nunca llega acá: `candidates()` devuelve `[]` y `ALL_KINDS` no lo incluye. */
async function neverReplayed(): Promise<{ status: string }> {
  throw new LedgerError("GL_SOURCE_INVALID", {
    reason: "opening_balance_is_not_replayed",
  });
}

const HANDLERS: Record<LedgerSourceKind, Handler> = {
  pos_invoice: { post: postInvoice, reverse: reverseInvoice },
  pos_credit_memo: { post: postCreditMemo, reverse: reverseCreditMemo },
  customer_payment: { post: postCustomerPayment, reverse: reverseCustomerPayment },
  rounding_adjustment: { post: postRoundingAdjustment, reverse: reverseRoundingAdjustment },
  po_receipt: { post: postReceipt, reverse: reverseReceipt },
  vendor_bill: { post: postVendorBill, reverse: reverseVendorBill },
  vendor_credit: { post: postVendorCredit, reverse: reverseVendorCredit },
  vendor_bill_payment: { post: postBillPayment, reverse: reverseBillPayment },
  opening_balance: { post: neverReplayed, reverse: neverReplayed },
};

/**
 * §5/§8 — idempotente: cada documento se intenta dentro de su propio
 * SAVEPOINT. En dry-run (`apply: false`, default recomendado por el caller)
 * el savepoint se revierte SIEMPRE, así que replayLedger nunca escribe salvo
 * que se pida explícitamente — la única forma de saber si un documento
 * postearía limpio es intentarlo de verdad contra los triggers reales.
 */
export async function replayLedger(
  client: PoolClient,
  options: ReplayOptions
): Promise<ReplayReport> {
  const kinds = options.kinds ?? ALL_KINDS;
  const limit = options.limit ?? 200;
  const counts = {} as Record<LedgerSourceKind, ReplayCounts>;
  for (const k of ALL_KINDS) counts[k] = emptyCounts();
  counts.opening_balance = emptyCounts();
  const blocked: ReplayBlock[] = [];

  for (const kind of kinds) {
    const rows = await candidates(client, kind, options.from, options.to, limit);
    const handler = HANDLERS[kind];
    for (const row of rows) {
      const savepoint = `gl_replay_${Math.random().toString(36).slice(2, 12)}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const result =
          row.terminal === "reverse"
            ? await handler.reverse(client, row.id, REPLAY_ACTOR)
            : await handler.post(client, row.id, REPLAY_ACTOR);
        if (result.status === "posted") counts[kind].posted++;
        else if (result.status === "already_posted") counts[kind].already_posted++;
        else if (result.status === "reversed") counts[kind].reversed++;
        // "already_reversed" / "nothing_to_reverse": no-op, no cuentan como bloqueo.
        if (!options.apply) await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        else await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        counts[kind].blocked++;
        if (blocked.length < BLOCK_REPORT_CAP) {
          blocked.push({
            source_kind: kind,
            source_id: row.id,
            code: err instanceof LedgerError ? err.code : "GL_SOURCE_INVALID",
          });
        }
      }
    }
  }

  return { apply: options.apply, counts, blocked };
}
