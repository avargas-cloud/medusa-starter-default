/**
 * qb-vendor-credit-apply-enqueue.ts
 *
 * vc-apply-qb-20260915. QuickBooks has no document for "link a vendor credit
 * to a bill" — the only way is a $0 Pay Bills: `BillPaymentCreditCardAddRq`
 * with `PaymentAmount 0.00` + `SetCredit{CreditTxnID, AppliedAmount}`.
 * Probed against prod 09/15/2026 (6 times): QuickBooks answers
 * `statusCode 0` and the `BillPaymentCreditCardRet` comes back WITHOUT a
 * `TxnID` — no document is minted. The link is confirmed by READBACK
 * (`poll-submitted-rows.ts`'s dedicated branch, never the shared VC/BP one):
 * re-query the bill with `IncludeLinkedTxns` and look for
 * `LinkedTxn{TxnType=VendorCredit, TxnID=<credit>}`.
 *
 * Mirrors `qb-bill-payment-enqueue.ts`'s shape: ONE function
 * (`loadVendorCreditApplyFacts`) decides readiness AND builds the QBXML, so
 * enqueue-time and dispatch-time (`resubmit-by-step.ts`) never diverge on
 * what "ready" means.
 */

import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
  type PurchaseDependencyKnex,
} from "./qb-purchase-dependency-chain";
import { buildBillPaymentCreditCardAddQbxml } from "../quickbooks/bill-payment-add";
import { isQbSyncEnabled } from "../quickbooks/sync-enabled";
import { getBusinessDateString } from "../date/et";
import {
  loadApAccountListId,
  loadCreditCardAccountListId,
  findBlockingAddOperationId,
} from "./qb-vendor-credit-apply-accounts";

export type EnqueueKnex = PurchaseDependencyKnex;

export type EnqueueResult =
  | { queued: true; pipelineRowId: string }
  | { queued: false; reason: string };

interface ApplicationRow {
  id: string;
  credit_id: string;
  vendor_bill_id: string;
  amount_cents: string | number;
  applied_at: string;
  voided_at: string | null;
}

interface CreditRow {
  id: string;
  number: string | null;
  qb_txn_id: string | null;
  vendor_qb_list_id_snapshot: string | null;
}

interface BillRow {
  id: string;
  number: string | null;
  qb_txn_id: string | null;
}

/**
 * Live rows that mean "this document is being mutated in QuickBooks right
 * now" — minimum quiescence so the $0 apply never races a Mod/Void of the
 * SAME credit or bill (same discipline as `document-quiescence.ts`, applied
 * here as a plain readiness blocker instead of a per-attempt gate: this pair
 * of documents can't apply/unapply concurrently the way a payment can touch
 * many bills at once).
 */
const LIVE_MUTATION_STEPS = [
  "vendor_credit_mod",
  "vendor_credit_void",
  "vendor_bill_mod",
  "vendor_bill_void",
];
const LIVE_MUTATION_STATUSES = ["waiting", "pending", "processing", "submitted"];

export type VendorCreditApplyFacts =
  | {
      ready: true;
      qbxml: string;
      billTxnId: string;
      creditTxnId: string;
      amountCents: bigint;
      blockingReferenceIds: [];
    }
  | { ready: false; reason: string; blockingReferenceIds: string[] };

/**
 * The ONE place that decides whether a `vendor_credit_apply` can be built,
 * and builds it. Called at enqueue time AND meant to be called again,
 * unchanged, by the dispatcher right before the bridge call.
 */
export async function loadVendorCreditApplyFacts(
  knex: EnqueueKnex,
  applicationId: string
): Promise<VendorCreditApplyFacts> {
  const appResult = await knex.raw(
    `SELECT a.id, a.credit_id, a.vendor_bill_id, a.amount_cents, a.applied_at, a.voided_at
       FROM vendor_credit_application a
      WHERE a.id = ?`,
    [applicationId]
  );
  const app = (appResult.rows[0] ?? null) as ApplicationRow | null;
  if (!app) {
    return { ready: false, reason: "vendor credit application not found", blockingReferenceIds: [] };
  }
  if (app.voided_at) {
    return { ready: false, reason: "application voided", blockingReferenceIds: [] };
  }

  const creditResult = await knex.raw(
    `SELECT vc.id, vc.number, vc.qb_txn_id, vc.vendor_qb_list_id_snapshot
       FROM vendor_credit vc
      WHERE vc.id = ? AND vc.deleted_at IS NULL`,
    [app.credit_id]
  );
  const credit = (creditResult.rows[0] ?? null) as CreditRow | null;
  if (!credit) {
    return { ready: false, reason: "vendor credit not found", blockingReferenceIds: [] };
  }

  const billResult = await knex.raw(
    `SELECT vb.id, vb.number, vb.qb_txn_id
       FROM vendor_bill vb
      WHERE vb.id = ? AND vb.deleted_at IS NULL`,
    [app.vendor_bill_id]
  );
  const bill = (billResult.rows[0] ?? null) as BillRow | null;
  if (!bill) {
    return { ready: false, reason: "vendor bill not found", blockingReferenceIds: [] };
  }

  const blocking = new Set<string>();
  if (!bill.qb_txn_id) blocking.add(bill.id);
  if (!credit.qb_txn_id) blocking.add(credit.id);

  const liveResult = await knex.raw(
    `SELECT DISTINCT reference_id FROM qb_order_pipeline
      WHERE reference_id IN (?, ?)
        AND step IN (${LIVE_MUTATION_STEPS.map(() => "?").join(", ")})
        AND status IN (${LIVE_MUTATION_STATUSES.map(() => "?").join(", ")})`,
    [credit.id, bill.id, ...LIVE_MUTATION_STEPS, ...LIVE_MUTATION_STATUSES]
  );
  for (const row of liveResult.rows as { reference_id: string }[]) {
    if (row.reference_id) blocking.add(row.reference_id);
  }

  if (blocking.size > 0) {
    return {
      ready: false,
      reason: `waiting for QuickBooks: ${[...blocking].join(", ")}`,
      blockingReferenceIds: [...blocking],
    };
  }

  if (!credit.vendor_qb_list_id_snapshot) {
    return { ready: false, reason: "vendor credit has no vendor QB ListID", blockingReferenceIds: [] };
  }

  const apAccountListId = await loadApAccountListId(knex);
  if (!apAccountListId) {
    return { ready: false, reason: "gl_account_map has no 'accounts_payable' entry", blockingReferenceIds: [] };
  }

  const creditCardAccountListId = await loadCreditCardAccountListId(knex, credit.id);
  if (!creditCardAccountListId) {
    return { ready: false, reason: "no CreditCard account available", blockingReferenceIds: [] };
  }

  const txnDate = getBusinessDateString(app.applied_at);
  const memo = `EcoPowerTech: ${credit.number ?? credit.id} applied to ${bill.number ?? bill.id}`;
  const amountCents = BigInt(Math.round(Number(app.amount_cents)));

  try {
    const qbxml = buildBillPaymentCreditCardAddQbxml({
      payeeListId: credit.vendor_qb_list_id_snapshot,
      apAccountListId,
      txnDate,
      refNumber: null,
      memo,
      creditCardAccountListId,
      appliedToTxns: [
        {
          billTxnId: bill.qb_txn_id as string,
          paymentAmountCents: 0n,
          setCredits: [
            {
              creditTxnId: credit.qb_txn_id as string,
              appliedAmountCents: amountCents,
            },
          ],
        },
      ],
    });
    return {
      ready: true,
      qbxml,
      billTxnId: bill.qb_txn_id as string,
      creditTxnId: credit.qb_txn_id as string,
      amountCents,
      blockingReferenceIds: [],
    };
  } catch (error) {
    return {
      ready: false,
      reason: error instanceof Error ? error.message : "could not build BillPaymentCreditCardAdd QBXML",
      blockingReferenceIds: [],
    };
  }
}

export async function enqueueVendorCreditApply(
  knex: EnqueueKnex,
  applicationId: string
): Promise<EnqueueResult> {
  if (!isQbSyncEnabled()) {
    return { queued: false, reason: "QB_SYNC_ENABLED=false" };
  }

  const facts = await loadVendorCreditApplyFacts(knex, applicationId);

  if (!facts.ready && facts.blockingReferenceIds.length === 0) {
    // Structural problem (no CreditCard account, missing vendor ListID,
    // voided application, etc.) — fail closed like the sibling lanes do for
    // the same class of problem, instead of manufacturing a row that waits
    // forever.
    return { queued: false, reason: facts.reason };
  }

  const idsResult = await knex.raw(
    `SELECT credit_id, vendor_bill_id FROM vendor_credit_application WHERE id = ?`,
    [applicationId]
  );
  const ids = (idsResult.rows[0] ?? null) as
    | { credit_id?: string; vendor_bill_id?: string }
    | null;

  const payload: Record<string, unknown> = facts.ready
    ? {
        vendor_credit_application_id: applicationId,
        vendor_credit_id: ids?.credit_id ?? null,
        vendor_bill_id: ids?.vendor_bill_id ?? null,
        amount_cents: facts.amountCents.toString(),
        qbxml: facts.qbxml,
        bill_txn_id: facts.billTxnId,
        credit_txn_id: facts.creditTxnId,
        ready: true,
      }
    : {
        vendor_credit_application_id: applicationId,
        vendor_credit_id: ids?.credit_id ?? null,
        vendor_bill_id: ids?.vendor_bill_id ?? null,
        qbxml: null,
        ready: false,
        blocking_reference_ids: facts.blockingReferenceIds,
      };

  const operation = await enqueuePurchaseQbOperation(knex, {
    purchaseOrderId: applicationId,
    referenceId: applicationId,
    referenceType: "vendor_credit_application",
    step: "vendor_credit_apply",
    payload,
    // The key deliberately does NOT include the qbxml: re-enqueuing the same
    // application is the same operation — including the qbxml would let a
    // re-add duplicate the SetCredit.
    operationKey: purchaseOperationKey("vendor_credit_apply", applicationId, {
      vendor_credit_application_id: applicationId,
    }),
  });

  // Already checked isQbSyncEnabled() at the top of this function — defense
  // against a future caller change, not an expected path.
  if (!operation) {
    return { queued: false, reason: "QB_SYNC_ENABLED=false" };
  }

  if (!facts.ready) {
    const blockerOpId = await findBlockingAddOperationId(
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
