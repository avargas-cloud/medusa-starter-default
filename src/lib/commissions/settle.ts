/**
 * Order Commissions — liquidación (docs/ORDER_COMMISSIONS_PLAN.md §11.2).
 *
 * Caso store_credit (2 documentos QB, patrón clearing/barter):
 *   1. `commission_check`   — CheckAdd desde la clearing al VENDOR (Dr gasto / Cr clearing)
 *   2. `commission_payment` — ReceivePaymentAdd al CUSTOMER sin aplicar, depositado
 *      a la MISMA clearing (Dr clearing / Cr A/R) → el crédito gastable.
 * Las filas viven en `qb_order_pipeline` como lane propio (delta v2): la ruta solo
 * ESCRIBE filas; despacha el consolidator y confirma el poller — nunca éxito al
 * encolar. El payment nace `waiting` con depends_on de la fila del check: la plata
 * no "entra" a la clearing antes de que el check que la fondea esté confirmado.
 *
 * Caso vendor_bill: el bill se crea por el chokepoint existente de vendor-bills
 * (la página lo orquesta); acá solo se VALIDA y se linkea. Cierra cuando el bill
 * confirma en QB (reconcile en cada refresh + digest).
 *
 * El crédito POS es un `customer_payment` type='payment' + method='credit_memo'
 * + metadata.is_commission_credit='true':
 *   · type='payment'  → el panel de créditos lo muestra y el gasto va por el
 *     merge-apply de siempre (ReceivePaymentMod sobre NUESTRO TxnID);
 *   · method='credit_memo' → Treasury ya trata su gasto como venta no-cash;
 *   · el marker de metadata → excluido de los CTEs de cash del día (no es plata
 *     de caja: salió de la clearing y volvió).
 */

import type { PoolClient } from "pg";
import { randomUUID } from "crypto";

import { CommissionError, asInt, type CommissionRow, type RecipientRow } from "./writer";
import type { CommissionQbAccounts } from "./config";

export const COMMISSION_CHECK_STEP = "commission_check";
export const COMMISSION_PAYMENT_STEP = "commission_payment";

export interface ResolvedBeneficiary {
  /** qb_vendor.id local (qbvnd_…) */
  qbVendorId: string;
  /** ListID real de QB (nunca pending_) */
  vendorListId: string;
  vendorFullName: string;
  /** customer de Medusa (para el crédito) — null si no hay link */
  customerId: string | null;
  /** ListID QB del customer — null si no está sincronizado */
  customerQbListId: string | null;
}

/**
 * Resuelve la identidad completa del beneficiario: vendor SIEMPRE (el check/bill
 * sale a su nombre), customer solo si existe (obligatorio para store_credit).
 */
export async function resolveBeneficiary(
  client: PoolClient,
  recipient: RecipientRow
): Promise<ResolvedBeneficiary> {
  let qbVendorId = recipient.qb_vendor_id;
  let customerId = recipient.customer_id;

  if (!qbVendorId && customerId) {
    const { rows } = await client.query<{ qb_vendor_id: string }>(
      `SELECT qb_vendor_id FROM customer_vendor_link
        WHERE customer_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [customerId]
    );
    qbVendorId = rows[0]?.qb_vendor_id ?? null;
  }
  if (!customerId && qbVendorId) {
    const { rows } = await client.query<{ customer_id: string }>(
      `SELECT customer_id FROM customer_vendor_link
        WHERE qb_vendor_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [qbVendorId]
    );
    customerId = rows[0]?.customer_id ?? null;
  }

  if (!qbVendorId) {
    throw new CommissionError(
      "invalid_state",
      "This beneficiary has no QuickBooks vendor — create it from the commissions page (Comm suffix) before settling.",
      { reason: "vendor_link_missing" }
    );
  }

  const { rows: vendorRows } = await client.query<{
    qb_list_id: string;
    full_name: string;
  }>(
    `SELECT qb_list_id, full_name FROM qb_vendor
      WHERE id = $1 AND deleted_at IS NULL AND is_active = true LIMIT 1`,
    [qbVendorId]
  );
  const vendor = vendorRows[0];
  if (!vendor) {
    throw new CommissionError("invalid_state", "The beneficiary's vendor does not exist or is inactive.", {
      reason: "vendor_missing",
    });
  }
  if (!vendor.qb_list_id || vendor.qb_list_id.startsWith("pending_")) {
    throw new CommissionError(
      "invalid_state",
      "The vendor has not confirmed in QuickBooks yet — wait for the sync before settling.",
      { reason: "vendor_not_synced" }
    );
  }

  let customerQbListId: string | null = null;
  if (customerId) {
    const { rows } = await client.query<{ qb_list_id: string | null }>(
      `SELECT metadata->>'qb_list_id' AS qb_list_id
         FROM customer WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [customerId]
    );
    customerQbListId = rows[0]?.qb_list_id ?? null;
  }

  return {
    qbVendorId,
    vendorListId: vendor.qb_list_id,
    vendorFullName: vendor.full_name,
    customerId,
    customerQbListId,
  };
}

/** RefNumber ≤11 chars de QB: RC-<display>-<ordinal del beneficiario>. */
export function commissionRefNumber(orderDisplayId: string | null, ordinal: number): string {
  const display = (orderDisplayId ?? "").replace(/\D/g, "").slice(0, 6) || "0";
  return `RC-${display}-${ordinal}`;
}

export function commissionMemo(
  percentBps: number,
  orderDisplayId: string | null,
  beneficiaryName: string
): string {
  const pct = (percentBps / 100).toFixed(percentBps % 100 === 0 ? 0 : 2);
  return `Commission ${pct}% Order ${orderDisplayId ?? "?"} — ${beneficiaryName}`;
}

export interface SettlementInsert {
  recipientId: string;
  method: "vendor_bill" | "store_credit";
  amountCents: number;
  vendorBillId?: string | null;
  createdBy: string | null;
}

/** Inserta la fila de settlement. El índice parcial `uq_cset_live_per_recipient`
 *  es quien garantiza "un saldo, un camino" bajo concurrencia. */
export async function insertSettlement(
  client: PoolClient,
  input: SettlementInsert
): Promise<string> {
  const id = `cset_${randomUUID().replace(/-/g, "")}`;
  try {
    await client.query(
      `INSERT INTO commission_settlement
         (id, recipient_id, method, amount_cents, vendor_bill_id, status, idempotency_key, created_by)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)`,
      [
        id,
        input.recipientId,
        input.method,
        input.amountCents,
        input.vendorBillId ?? null,
        `commission-settle:${id}`,
        input.createdBy,
      ]
    );
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      throw new CommissionError(
        "invalid_state",
        "This recipient already has a live settlement — one balance goes through ONE path.",
        { reason: "settlement_exists" }
      );
    }
    throw err;
  }
  return id;
}

/**
 * Valida un vendor bill para el caso 1: del vendor correcto, monto exacto,
 * y con TODAS sus líneas contra la cuenta de comisión.
 */
export async function validateVendorBillForSettlement(
  client: PoolClient,
  vendorBillId: string,
  beneficiary: ResolvedBeneficiary,
  amountCents: number,
  accounts: CommissionQbAccounts
): Promise<void> {
  const { rows } = await client.query<{
    id: string;
    vendor_id: string;
    status: string;
  }>(
    `SELECT id, vendor_id, status FROM vendor_bill
      WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [vendorBillId]
  );
  const bill = rows[0];
  if (!bill) throw new CommissionError("not_found", "Vendor bill not found.");
  if (bill.vendor_id !== beneficiary.qbVendorId) {
    throw new CommissionError("invalid_state", "That bill belongs to a different vendor than the beneficiary.", {
      reason: "bill_vendor_mismatch",
    });
  }
  if (!["draft", "confirmed"].includes(bill.status)) {
    throw new CommissionError("invalid_state", `The bill is in state '${bill.status}'.`, {
      reason: "bill_bad_status",
    });
  }

  const { rows: lineRows } = await client.query<{
    total_cents: string | number | null;
    off_account: string | number | null;
  }>(
    `SELECT SUM(COALESCE(amount_cents, ROUND(qty * unit_cost_cents)))::bigint AS total_cents,
            COUNT(*) FILTER (WHERE qb_account_list_id IS DISTINCT FROM $2) AS off_account
       FROM vendor_bill_line
      WHERE vendor_bill_id = $1 AND deleted_at IS NULL AND line_type = 'qb_account'`,
    [vendorBillId, accounts.expenseAccountListId]
  );
  const total = asInt(lineRows[0]?.total_cents);
  const offAccount = asInt(lineRows[0]?.off_account);
  if (total !== amountCents) {
    throw new CommissionError(
      "invalid_state",
      `The bill totals ${total}¢ but the approved commission is ${amountCents}¢ — they must match exactly.`,
      { reason: "bill_amount_mismatch", billCents: total, approvedCents: amountCents }
    );
  }
  if (offAccount > 0) {
    throw new CommissionError(
      "invalid_state",
      "Every bill line must post to the configured commission account.",
      { reason: "bill_wrong_account" }
    );
  }
}

/**
 * Cierra settlements de vendor_bill cuyo bill ya confirmó en QB.
 * La llaman el listado (refresh-on-read) y el digest — mismo criterio del
 * payment-check: QuickBooks es el dueño del estado, el POS lo refleja.
 */
export async function reconcileVendorBillSettlements(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ id: string; recipient_id: string; qb_txn_id: string }>(
    `SELECT s.id, s.recipient_id, vb.qb_txn_id
       FROM commission_settlement s
       JOIN vendor_bill vb ON vb.id = s.vendor_bill_id
      WHERE s.method = 'vendor_bill'
        AND s.status IN ('pending', 'qb_waiting')
        AND vb.qb_txn_id IS NOT NULL`
  );
  for (const row of rows) {
    await client.query(
      `UPDATE commission_settlement
          SET status = 'confirmed', qb_check_txn_id = NULL, updated_at = NOW()
        WHERE id = $1 AND status IN ('pending', 'qb_waiting')`,
      [row.id]
    );
    await client.query(
      `UPDATE order_commission_recipient
          SET state = 'closed', settled_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND state = 'settling'`,
      [row.recipient_id]
    );
  }
  return rows.length;
}

/** Ordinal (1-based) del beneficiario dentro de su comisión, para el RefNumber. */
export function recipientOrdinal(recipients: RecipientRow[], recipientId: string): number {
  const idx = recipients.findIndex((r) => r.id === recipientId);
  return idx >= 0 ? idx + 1 : 1;
}

export interface StoreCreditPipelinePayloads {
  check: Record<string, unknown>;
  payment: Record<string, unknown>;
}

export function buildStoreCreditPayloads(input: {
  settlementId: string;
  amountCents: number;
  beneficiary: ResolvedBeneficiary;
  accounts: CommissionQbAccounts;
  refNumber: string;
  memo: string;
  txnDate: string;
  customerPaymentId: string;
  commission: CommissionRow;
}): StoreCreditPipelinePayloads {
  const amountDollars = (input.amountCents / 100).toFixed(2);
  return {
    check: {
      settlementId: input.settlementId,
      amountDollars,
      vendorListId: input.beneficiary.vendorListId,
      vendorFullName: input.beneficiary.vendorFullName,
      clearingListId: input.accounts.clearingAccountListId,
      expenseListId: input.accounts.expenseAccountListId,
      refNumber: input.refNumber,
      memo: input.memo,
      txnDate: input.txnDate,
    },
    payment: {
      settlementId: input.settlementId,
      amountDollars,
      customerListId: input.beneficiary.customerQbListId,
      customerPaymentId: input.customerPaymentId,
      depositAccountFullName: input.accounts.clearingAccountFullName,
      memo: input.memo,
      txnDate: input.txnDate,
    },
  };
}
