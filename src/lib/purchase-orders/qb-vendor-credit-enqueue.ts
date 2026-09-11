/**
 * qb-vendor-credit-enqueue.ts
 *
 * gl-purchases-v2 §3+§4 (docs/GL_PURCHASES_PLAN.md). Freezes a `vendor_credit`
 * into a `qb_order_pipeline` `vendor_credit_add`/`vendor_credit_void`
 * operation, mirroring `qb-vendor-bill-enqueue.ts`'s ADD lane:
 *
 *  - Gated by `QB_VENDOR_BILL_MODE === 'bill'`, same flag as vendor bills —
 *    this is the same Purchase-side QB integration, not a separate rollout.
 *  - Vendor identity resolves AT ENQUEUE (dispatch-adjacent), fail-closed on
 *    a `pending_` or missing ListID — same rule as VB-1148
 *    (`vendor-bill-vendor-identity.ts`), reused here via the same pure
 *    `decideVendorIdentity`.
 *  - ADD is NOT idempotent: `enqueuePurchaseQbOperation` dedupes by
 *    `operationKey` and its own-document chain (keyed by `creditId`) refuses
 *    to re-add a document whose add already reached QuickBooks — same
 *    protection `vendor_bill_add` gets, extended here for free by reusing
 *    the same primitive.
 *  - VOID requires the credit's OWN `qb_txn_id` to exist first; enqueuing it
 *    before the add confirmed would build a TxnVoidRq with nothing to void.
 */

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseDependencyKnex,
} from "./qb-purchase-dependency-chain";
import { decideVendorIdentity } from "./vendor-bill-vendor-identity";
import {
  buildVendorCreditAddQbxml,
  type VendorCreditExpenseLineInput,
  type VendorCreditItemLineInput,
} from "../quickbooks/vendor-credit-add";
import { buildTxnVoidQbxml } from "../quickbooks/txn-void-add";
import { toQbRefNumber } from "../quickbooks/qb-ref-number";

export type EnqueueKnex = PurchaseDependencyKnex;

export type EnqueueResult =
  | { queued: true; pipelineRowId: string }
  | { queued: false; reason: string };

interface CreditRow {
  id: string;
  number: string | null;
  status: string;
  vendor_id: string | null;
  vendor_qb_list_id_snapshot: string | null;
  vendor_name_snapshot: string | null;
  credit_date: string;
  memo: string | null;
  qb_txn_id: string | null;
}

interface CreditLineRow {
  id: string;
  line_type: string;
  variant_id: string | null;
  qty: number | null;
  unit_cost_cents: string | number | null;
  qb_account_list_id: string | null;
  amount_cents: string | number;
  variant_qb_item_list_id: string | null;
}

async function loadApAccountListId(
  knex: EnqueueKnex
): Promise<string | null> {
  const result = await knex.raw(
    `SELECT qb_list_id FROM gl_account_map WHERE key = 'accounts_payable' LIMIT 1`
  );
  return (
    (result.rows[0] as { qb_list_id?: string } | undefined)?.qb_list_id ??
    null
  );
}

async function resolveCreditVendorIdentity(
  knex: EnqueueKnex,
  credit: CreditRow
): Promise<
  | { resolved: true; list_id: string; name: string | null }
  | { resolved: false; reason: string }
> {
  const snapshotUsable =
    typeof credit.vendor_qb_list_id_snapshot === "string" &&
    credit.vendor_qb_list_id_snapshot.length > 0 &&
    !credit.vendor_qb_list_id_snapshot.startsWith("pending_");

  let liveListId: string | null = null;
  let liveName: string | null = null;
  if (!snapshotUsable && credit.vendor_id) {
    const result = await knex.raw(
      `SELECT qb_list_id, full_name FROM qb_vendor WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [credit.vendor_id]
    );
    const row = (result.rows[0] ?? null) as
      | { qb_list_id: string | null; full_name: string | null }
      | null;
    liveListId = row?.qb_list_id ?? null;
    liveName = row?.full_name ?? null;
  }

  const verdict = decideVendorIdentity({
    snapshot_list_id: credit.vendor_qb_list_id_snapshot,
    snapshot_name: credit.vendor_name_snapshot,
    live_list_id: liveListId,
    live_name: liveName,
  });

  if (!verdict.resolved) return verdict;

  if (verdict.source === "live") {
    await knex.raw(
      `UPDATE vendor_credit
          SET vendor_qb_list_id_snapshot = ?, vendor_name_snapshot = COALESCE(vendor_name_snapshot, ?), updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [verdict.list_id, verdict.name, credit.id]
    );
  }

  return { resolved: true, list_id: verdict.list_id, name: verdict.name };
}

export type VendorCreditAddFacts =
  | { ready: true; qbxml: string }
  | { ready: false; reason: string };

/**
 * The ONE place that decides whether a `vendor_credit_add` can be built, and
 * builds it — same role as `loadBillPaymentAddFacts` in
 * `qb-bill-payment-enqueue.ts`. Called at enqueue time AND meant to be
 * called again, unchanged, by the dispatcher (`resubmit-by-step.ts`) right
 * before the bridge call, so a vendor that synced (or a line that got its
 * item ListID) in between never has to wait for a human to re-enqueue.
 */
export async function loadVendorCreditAddFacts(
  knex: EnqueueKnex,
  vendorCreditId: string
): Promise<VendorCreditAddFacts> {
  const creditResult = await knex.raw(
    `SELECT id, number, status, vendor_id, vendor_qb_list_id_snapshot,
            vendor_name_snapshot, credit_date, memo, qb_txn_id
       FROM vendor_credit
      WHERE id = ? AND deleted_at IS NULL`,
    [vendorCreditId]
  );
  const credit = (creditResult.rows[0] ?? null) as CreditRow | null;
  if (!credit) return { ready: false, reason: "vendor credit not found" };
  if (credit.status !== "posted") {
    return { ready: false, reason: `vendor credit status is '${credit.status}', expected 'posted'` };
  }
  if (credit.qb_txn_id) {
    return { ready: false, reason: "vendor credit already has a qb_txn_id" };
  }

  const identity = await resolveCreditVendorIdentity(knex, credit);
  if (!identity.resolved) return { ready: false, reason: identity.reason };

  const apAccountListId = await loadApAccountListId(knex);
  if (!apAccountListId) {
    return { ready: false, reason: "gl_account_map has no 'accounts_payable' entry" };
  }

  const linesResult = await knex.raw(
    `SELECT vcl.id, vcl.line_type, vcl.variant_id, vcl.qty, vcl.unit_cost_cents,
            vcl.qb_account_list_id, vcl.amount_cents,
            pv.metadata ->> 'quickbooks_id' AS variant_qb_item_list_id
       FROM vendor_credit_line vcl
       LEFT JOIN product_variant pv
         ON pv.id = vcl.variant_id AND pv.deleted_at IS NULL
      WHERE vcl.credit_id = ? AND vcl.deleted_at IS NULL
      ORDER BY vcl.sort ASC, vcl.created_at ASC`,
    [vendorCreditId]
  );
  const lines = linesResult.rows as CreditLineRow[];
  if (lines.length === 0) {
    return { ready: false, reason: "vendor credit has no lines" };
  }

  const itemLines: VendorCreditItemLineInput[] = [];
  const expenseLines: VendorCreditExpenseLineInput[] = [];
  for (const line of lines) {
    if (line.line_type === "product") {
      if (!line.variant_qb_item_list_id) {
        return {
          ready: false,
          reason: `vendor credit line ${line.id} has no QB item ListID for its variant`,
        };
      }
      const qty = Number(line.qty ?? 0);
      itemLines.push({
        itemListId: line.variant_qb_item_list_id,
        quantity: qty,
        unitCostCents: BigInt(Math.round(Number(line.unit_cost_cents ?? 0))),
        amountCents: BigInt(Math.round(Number(line.amount_cents))),
      });
    } else {
      if (!line.qb_account_list_id) {
        return {
          ready: false,
          reason: `vendor credit line ${line.id} has no QB account`,
        };
      }
      expenseLines.push({
        accountListId: line.qb_account_list_id,
        amountCents: BigInt(Math.round(Number(line.amount_cents))),
      });
    }
  }

  const toDateOnly = (v: string): string => new Date(v).toISOString().slice(0, 10);

  try {
    const qbxml = buildVendorCreditAddQbxml({
      vendorListId: identity.list_id,
      apAccountListId,
      txnDate: toDateOnly(credit.credit_date),
      refNumber: toQbRefNumber(credit.number),
      memo: credit.memo,
      expenseLines,
      itemLines,
    });
    return { ready: true, qbxml };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : "could not build VendorCreditAdd QBXML",
    };
  }
}

export async function enqueueVendorCreditAdd(
  knex: EnqueueKnex,
  vendorCreditId: string
): Promise<EnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill' (flag off)" };
  }

  const facts = await loadVendorCreditAddFacts(knex, vendorCreditId);
  if (!facts.ready) return { queued: false, reason: facts.reason };

  const payload = {
    vendor_credit_id: vendorCreditId,
    qbxml: facts.qbxml,
  };

  const operation = await enqueuePurchaseQbOperation(knex, {
    // Own-document chain — a credit has no purchase order, exactly like an
    // expense vendor bill (qb-vendor-bill-enqueue.ts's `bill.purchase_order_id
    // ?? bill.id`).
    purchaseOrderId: vendorCreditId,
    referenceId: vendorCreditId,
    referenceType: "vendor_credit",
    step: "vendor_credit_add",
    payload,
    operationKey: purchaseOperationKey("vendor_credit_add", vendorCreditId, payload),
  });

  return { queued: true, pipelineRowId: operation.id };
}

export async function enqueueVendorCreditVoid(
  knex: EnqueueKnex,
  vendorCreditId: string
): Promise<EnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill' (flag off)" };
  }

  const creditResult = await knex.raw(
    `SELECT id, number, status, vendor_id, vendor_qb_list_id_snapshot,
            vendor_name_snapshot, credit_date, memo, qb_txn_id
       FROM vendor_credit
      WHERE id = ? AND deleted_at IS NULL`,
    [vendorCreditId]
  );
  const credit = (creditResult.rows[0] ?? null) as CreditRow | null;
  if (!credit) return { queued: false, reason: "vendor credit not found" };
  if (!credit.qb_txn_id) {
    return { queued: false, reason: "vendor credit has no qb_txn_id yet — its add has not confirmed" };
  }

  let qbxml: string;
  try {
    qbxml = buildTxnVoidQbxml("VendorCredit", credit.qb_txn_id);
  } catch (error) {
    return {
      queued: false,
      reason: error instanceof Error ? error.message : "could not build TxnVoidRq",
    };
  }

  const payload = {
    vendor_credit_id: credit.id,
    qb_txn_id: credit.qb_txn_id,
    qbxml,
  };

  const operation = await enqueuePurchaseQbOperation(knex, {
    purchaseOrderId: credit.id,
    referenceId: credit.id,
    referenceType: "vendor_credit",
    step: "vendor_credit_void",
    payload,
    qbTxnId: credit.qb_txn_id,
    operationKey: purchaseOperationKey("vendor_credit_void", credit.id, payload),
  });

  return { queued: true, pipelineRowId: operation.id };
}
