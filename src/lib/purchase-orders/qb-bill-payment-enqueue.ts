/**
 * qb-bill-payment-enqueue.ts
 *
 * gl-purchases-v2 §3+§4 (docs/GL_PURCHASES_PLAN.md). Freezes a
 * `vendor_bill_payment` into a `qb_order_pipeline`
 * `bill_payment_add`/`bill_payment_void` operation.
 *
 * DEPENDENCY CHOICE (documented per the plan's own ask): a payment can
 * allocate across MULTIPLE bills (`vendor_bill_payment_allocation`) and,
 * through `credit_application_id`, reference a vendor credit too. The plan's
 * §4 text says "si no, `waiting` con `depends_on`" — but `depends_on` is ONE
 * column pointing at ONE parent row, and this codebase already hit exactly
 * this shape once before: `apply_payment`'s cross-document readiness
 * (`.claude/rules/qb-pipeline.md` 2026-07-28, `document-quiescence.ts`) is
 * explicitly "NUNCA modelarlo con depends_on: es UNA columna para DOS
 * documentos" — and a bill payment can reference an unbounded N, not two.
 * Following that precedent instead of a literal single-parent `depends_on`:
 * the row is still enqueued (`queued: true`) in `waiting` with `depends_on`
 * best-effort pointed at ONE blocking bill's own `vendor_bill_add` operation
 * (for the UI — clicking it explains ONE reason it is stuck), and the FULL
 * list of blocking bill/credit ids rides in `payload.blocking_reference_ids`
 * for whatever re-checks readiness (a wake pass, or the dispatcher itself)
 * to verify ALL of them, not just the one `depends_on` points at.
 * `loadBillPaymentAddFacts` is the one place that decides readiness AND
 * builds the QBXML, so enqueue-time and (future R3) dispatch-time never
 * diverge on what "ready" means.
 */

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseDependencyKnex,
} from "./qb-purchase-dependency-chain";
import { decideVendorIdentity } from "./vendor-bill-vendor-identity";
import {
  buildBillPaymentCheckAddQbxml,
  buildBillPaymentCreditCardAddQbxml,
  type AppliedToTxnInput,
} from "../quickbooks/bill-payment-add";
import { buildTxnVoidQbxml } from "../quickbooks/txn-void-add";
import { toQbRefNumber } from "../quickbooks/qb-ref-number";

export type EnqueueKnex = PurchaseDependencyKnex;

export type EnqueueResult =
  | { queued: true; pipelineRowId: string }
  | { queued: false; reason: string };

interface PaymentRow {
  id: string;
  number: string | null;
  status: string;
  vendor_id: string | null;
  vendor_qb_list_id_snapshot: string | null;
  vendor_name_snapshot: string | null;
  bank_account_list_id: string;
  payment_date: string;
  method: string;
  reference: string | null;
  amount_cents: string | number;
  memo: string | null;
  qb_txn_id: string | null;
}

interface AllocationRow {
  id: string;
  vendor_bill_id: string;
  amount_cents: string | number;
  credit_application_id: string | null;
  bill_qb_txn_id: string | null;
  credit_id: string | null;
  credit_qb_txn_id: string | null;
}

async function loadApAccountListId(knex: EnqueueKnex): Promise<string | null> {
  const result = await knex.raw(
    `SELECT qb_list_id FROM gl_account_map WHERE key = 'accounts_payable' LIMIT 1`
  );
  return (
    (result.rows[0] as { qb_list_id?: string } | undefined)?.qb_list_id ?? null
  );
}

async function resolvePaymentVendorIdentity(
  knex: EnqueueKnex,
  payment: PaymentRow
): Promise<
  | { resolved: true; list_id: string; name: string | null }
  | { resolved: false; reason: string }
> {
  const snapshotUsable =
    typeof payment.vendor_qb_list_id_snapshot === "string" &&
    payment.vendor_qb_list_id_snapshot.length > 0 &&
    !payment.vendor_qb_list_id_snapshot.startsWith("pending_");

  let liveListId: string | null = null;
  let liveName: string | null = null;
  if (!snapshotUsable && payment.vendor_id) {
    const result = await knex.raw(
      `SELECT qb_list_id, full_name FROM qb_vendor WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [payment.vendor_id]
    );
    const row = (result.rows[0] ?? null) as
      | { qb_list_id: string | null; full_name: string | null }
      | null;
    liveListId = row?.qb_list_id ?? null;
    liveName = row?.full_name ?? null;
  }

  const verdict = decideVendorIdentity({
    snapshot_list_id: payment.vendor_qb_list_id_snapshot,
    snapshot_name: payment.vendor_name_snapshot,
    live_list_id: liveListId,
    live_name: liveName,
  });
  if (!verdict.resolved) return verdict;

  if (verdict.source === "live") {
    await knex.raw(
      `UPDATE vendor_bill_payment
          SET vendor_qb_list_id_snapshot = ?, vendor_name_snapshot = COALESCE(vendor_name_snapshot, ?), updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [verdict.list_id, verdict.name, payment.id]
    );
  }
  return { resolved: true, list_id: verdict.list_id, name: verdict.name };
}

export type BillPaymentAddFacts =
  | {
      ready: true;
      qbxml: string;
      isCreditCard: boolean;
      blockingReferenceIds: [];
    }
  | {
      ready: false;
      reason: string;
      blockingReferenceIds: string[];
    };

/**
 * The ONE place that decides whether a `bill_payment_add` can be built, and
 * builds it. Called at enqueue time and meant to be called again, unchanged,
 * right before dispatch (R3) — so "ready" never means something different
 * in the two places.
 */
export async function loadBillPaymentAddFacts(
  knex: EnqueueKnex,
  paymentId: string
): Promise<BillPaymentAddFacts> {
  const paymentResult = await knex.raw(
    `SELECT id, number, status, vendor_id, vendor_qb_list_id_snapshot,
            vendor_name_snapshot, bank_account_list_id, payment_date, method,
            reference, amount_cents, memo, qb_txn_id
       FROM vendor_bill_payment
      WHERE id = ? AND deleted_at IS NULL`,
    [paymentId]
  );
  const payment = (paymentResult.rows[0] ?? null) as PaymentRow | null;
  if (!payment) {
    return { ready: false, reason: "bill payment not found", blockingReferenceIds: [] };
  }
  if (payment.status !== "posted") {
    return {
      ready: false,
      reason: `bill payment status is '${payment.status}', expected 'posted'`,
      blockingReferenceIds: [],
    };
  }

  const identity = await resolvePaymentVendorIdentity(knex, payment);
  if (!identity.resolved) {
    return { ready: false, reason: identity.reason, blockingReferenceIds: [] };
  }

  const apAccountListId = await loadApAccountListId(knex);
  if (!apAccountListId) {
    return {
      ready: false,
      reason: "gl_account_map has no 'accounts_payable' entry",
      blockingReferenceIds: [],
    };
  }

  const allocResult = await knex.raw(
    `SELECT a.id, a.vendor_bill_id, a.amount_cents, a.credit_application_id,
            vb.qb_txn_id AS bill_qb_txn_id,
            vca.credit_id AS credit_id,
            vc.qb_txn_id AS credit_qb_txn_id
       FROM vendor_bill_payment_allocation a
       JOIN vendor_bill vb ON vb.id = a.vendor_bill_id
       LEFT JOIN vendor_credit_application vca ON vca.id = a.credit_application_id
       LEFT JOIN vendor_credit vc ON vc.id = vca.credit_id
      WHERE a.payment_id = ?
      ORDER BY a.created_at ASC`,
    [paymentId]
  );
  const allocations = allocResult.rows as AllocationRow[];
  if (allocations.length === 0) {
    return {
      ready: false,
      reason: "bill payment has no allocations",
      blockingReferenceIds: [],
    };
  }

  const blocking = new Set<string>();
  for (const alloc of allocations) {
    if (!alloc.bill_qb_txn_id) blocking.add(alloc.vendor_bill_id);
    if (alloc.credit_id && !alloc.credit_qb_txn_id) blocking.add(alloc.credit_id);
  }
  if (blocking.size > 0) {
    return {
      ready: false,
      reason: `waiting on QuickBooks TxnID for: ${[...blocking].join(", ")}`,
      blockingReferenceIds: [...blocking],
    };
  }

  // Group allocations by bill — one AppliedToTxnAdd per bill, one SetCredit
  // per credit application under it (plan §4 sample: TxnID → PaymentAmount →
  // SetCredit*).
  const byBill = new Map<string, AppliedToTxnInput>();
  for (const alloc of allocations) {
    const billTxnId = alloc.bill_qb_txn_id as string;
    const existing = byBill.get(billTxnId) ?? {
      billTxnId,
      paymentAmountCents: 0n,
      setCredits: [],
    };
    existing.paymentAmountCents =
      (existing.paymentAmountCents as bigint) + BigInt(Math.round(Number(alloc.amount_cents)));
    if (alloc.credit_qb_txn_id) {
      existing.setCredits = [
        ...(existing.setCredits ?? []),
        {
          creditTxnId: alloc.credit_qb_txn_id,
          // The allocation's own amount IS the credit's contribution when it
          // carries a credit_application_id (posting a credit-covered slice
          // of a bill never mixes cash and credit within one allocation row).
          appliedAmountCents: BigInt(Math.round(Number(alloc.amount_cents))),
        },
      ];
    }
    byBill.set(billTxnId, existing);
  }
  const appliedToTxns = [...byBill.values()];

  const toDateOnly = (v: string): string => new Date(v).toISOString().slice(0, 10);
  const bankOrCardResult = await knex.raw(
    `SELECT account_type FROM qb_account WHERE qb_list_id = ? LIMIT 1`,
    [payment.bank_account_list_id]
  );
  const accountType = (
    bankOrCardResult.rows[0] as { account_type?: string } | undefined
  )?.account_type;
  const isCreditCard = accountType === "CreditCard";

  try {
    const qbxml = isCreditCard
      ? buildBillPaymentCreditCardAddQbxml({
          payeeListId: identity.list_id,
          apAccountListId,
          txnDate: toDateOnly(payment.payment_date),
          refNumber: toQbRefNumber(payment.reference ?? payment.number),
          memo: payment.memo,
          creditCardAccountListId: payment.bank_account_list_id,
          appliedToTxns,
        })
      : buildBillPaymentCheckAddQbxml({
          payeeListId: identity.list_id,
          apAccountListId,
          txnDate: toDateOnly(payment.payment_date),
          refNumber: toQbRefNumber(payment.reference ?? payment.number),
          memo: payment.memo,
          bankAccountListId: payment.bank_account_list_id,
          appliedToTxns,
        });
    return { ready: true, qbxml, isCreditCard, blockingReferenceIds: [] };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : "could not build BillPaymentAdd QBXML",
      blockingReferenceIds: [],
    };
  }
}

/** Best-effort single pointer for the UI — see the module doc for why this is not the real gate. */
async function findBlockingBillAddOperationId(
  knex: EnqueueKnex,
  blockingBillId: string
): Promise<string | null> {
  const result = await knex.raw(
    `SELECT id FROM qb_order_pipeline
      WHERE reference_type = 'vendor_bill' AND reference_id = ? AND step = 'vendor_bill_add'
      ORDER BY created_at DESC LIMIT 1`,
    [blockingBillId]
  );
  return (result.rows[0] as { id?: string } | undefined)?.id ?? null;
}

export async function enqueueBillPaymentAdd(
  knex: EnqueueKnex,
  vendorBillPaymentId: string
): Promise<EnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill' (flag off)" };
  }

  const facts = await loadBillPaymentAddFacts(knex, vendorBillPaymentId);

  if (!facts.ready && facts.blockingReferenceIds.length === 0) {
    // Structural problem (no allocations, bad account map, unresolved
    // vendor identity, etc.) — nothing would ever make this ready on its
    // own; fail closed exactly like the vendor-bill lane does for the same
    // class of problem, instead of manufacturing a row that waits forever.
    return { queued: false, reason: facts.reason };
  }

  const payload: Record<string, unknown> = facts.ready
    ? { vendor_bill_payment_id: vendorBillPaymentId, qbxml: facts.qbxml, ready: true }
    : {
        vendor_bill_payment_id: vendorBillPaymentId,
        qbxml: null,
        ready: false,
        blocking_reference_ids: facts.blockingReferenceIds,
      };

  const operation = await enqueuePurchaseQbOperation(knex, {
    purchaseOrderId: vendorBillPaymentId,
    referenceId: vendorBillPaymentId,
    referenceType: "bill_payment",
    step: "bill_payment_add",
    payload,
    operationKey: purchaseOperationKey("bill_payment_add", vendorBillPaymentId, payload),
  });

  if (!facts.ready) {
    const blockerOpId = await findBlockingBillAddOperationId(
      knex,
      facts.blockingReferenceIds[0]!
    );
    await knex.raw(
      `UPDATE qb_order_pipeline
          SET status = 'waiting', depends_on = ?::uuid, updated_at = NOW()
        WHERE id = ?::uuid AND status NOT IN ('confirmed', 'fixed')`,
      [blockerOpId, operation.id]
    );
  }

  return { queued: true, pipelineRowId: operation.id };
}

export async function enqueueBillPaymentVoid(
  knex: EnqueueKnex,
  vendorBillPaymentId: string
): Promise<EnqueueResult> {
  if (process.env.QB_VENDOR_BILL_MODE !== "bill") {
    return { queued: false, reason: "QB_VENDOR_BILL_MODE is not 'bill' (flag off)" };
  }

  const paymentResult = await knex.raw(
    `SELECT id, qb_txn_id FROM vendor_bill_payment WHERE id = ? AND deleted_at IS NULL`,
    [vendorBillPaymentId]
  );
  const payment = (paymentResult.rows[0] ?? null) as
    | { id: string; qb_txn_id: string | null }
    | null;
  if (!payment) return { queued: false, reason: "bill payment not found" };
  if (!payment.qb_txn_id) {
    return { queued: false, reason: "bill payment has no qb_txn_id yet — its add has not confirmed" };
  }

  // Both txn types void through the same TxnVoidRq shape — the type name is
  // the only difference, and it must match whichever ADD actually posted.
  const bankOrCardResult = await knex.raw(
    `SELECT qb_account.account_type
       FROM vendor_bill_payment vbp
       JOIN qb_account ON qb_account.qb_list_id = vbp.bank_account_list_id
      WHERE vbp.id = ?`,
    [vendorBillPaymentId]
  );
  const accountType = (
    bankOrCardResult.rows[0] as { account_type?: string } | undefined
  )?.account_type;
  const txnVoidType = accountType === "CreditCard" ? "BillPaymentCreditCard" : "BillPaymentCheck";

  let qbxml: string;
  try {
    qbxml = buildTxnVoidQbxml(txnVoidType, payment.qb_txn_id);
  } catch (error) {
    return {
      queued: false,
      reason: error instanceof Error ? error.message : "could not build TxnVoidRq",
    };
  }

  const payload = {
    vendor_bill_payment_id: payment.id,
    qb_txn_id: payment.qb_txn_id,
    qbxml,
  };

  const operation = await enqueuePurchaseQbOperation(knex, {
    purchaseOrderId: payment.id,
    referenceId: payment.id,
    referenceType: "bill_payment",
    step: "bill_payment_void",
    payload,
    qbTxnId: payment.qb_txn_id,
    operationKey: purchaseOperationKey("bill_payment_void", payment.id, payload),
  });

  return { queued: true, pipelineRowId: operation.id };
}
