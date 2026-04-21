/**
 * fix-cm-1001-missing-payment.ts
 *
 * One-off data fix for CM-1001 (id=01KPRW05Y94SMRHKR3NE4TMKD4). At completion
 * (2026-04-21 20:34 UTC) the cashier (Ana Guedez) chose "Refund", but the
 * pre-fix code path tried to insert a customer_payment with method='refund' —
 * which violates the method CHECK constraint on customer_payment — and the
 * failure was silently swallowed. The Credit Memo landed in 'completed' state
 * (QB synced, invoice refunded_amount updated, Medusa refund emitted) but the
 * finance-ledger row that represents the customer's store credit / refund
 * simply never got created.
 *
 * This script replicates what the refactored /complete route's refund path
 * would do today:
 *   1. Sets pos_credit_memo.refund_method = 'refund' so the UI shows the badge.
 *   2. Creates customer_payment (type=credit_memo, method=credit_memo,
 *      reference='CM-1001', amount=4279, status=refunded) — mirroring the
 *      flip that /complete applies when refund_method='refund'.
 *   3. Queues a QB Write Check against Accounts Receivable (same mechanism
 *      accounting uses for every refund).
 *
 * The orphan native-Medusa refund (ref_01KPRW06CNG4ZYC500AEKM0JGX) is left
 * intact — it is internal Medusa tracking only, and the new /complete route
 * no longer emits it at all.
 *
 * Usage:
 *   DRY RUN:  yarn medusa exec ./src/scripts/fix/fix-cm-1001-missing-payment.ts
 *   APPLY:    APPLY=1 yarn medusa exec ./src/scripts/fix/fix-cm-1001-missing-payment.ts
 */
import { MedusaContainer } from "@medusajs/framework/types";

import { createCheckInQb } from "../../lib/quickbooks/client";
import { writePipelineRow } from "../../lib/quickbooks/qb-pipeline";
import { CREDIT_MEMO_MODULE } from "../../modules/credit_memos";
import { FINANCE_MODULE } from "../../modules/finance";

const CM_ID = "01KPRW05Y94SMRHKR3NE4TMKD4";
const CM_NUMBER = "CM-1001";
const CM_AMOUNT_CENTS = 4279;

export default async function fixCm1001MissingPayment({
  container,
}: {
  container: MedusaContainer;
}) {
  const apply = process.env.APPLY === "1";
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as any;
  const creditMemoService: any = container.resolve(CREDIT_MEMO_MODULE);
  const financeService: any = container.resolve(FINANCE_MODULE);

  const cmRow = await pg("pos_credit_memo")
    .where({ id: CM_ID })
    .select(
      "id",
      "credit_memo_number",
      "customer_id",
      "total",
      "status",
      "refund_method",
      "qb_txn_id"
    )
    .first();

  if (!cmRow) {
    logger.error(`[fix-cm-1001] Credit memo ${CM_ID} not found — aborting.`);
    return;
  }

  if (cmRow.credit_memo_number !== CM_NUMBER) {
    logger.error(
      `[fix-cm-1001] ID/number mismatch: expected ${CM_NUMBER}, got ${cmRow.credit_memo_number}. Aborting.`
    );
    return;
  }

  if (Number(cmRow.total) !== CM_AMOUNT_CENTS) {
    logger.error(
      `[fix-cm-1001] Amount sanity check failed: expected ${CM_AMOUNT_CENTS}, got ${cmRow.total}. Aborting.`
    );
    return;
  }

  // ─ Idempotency: existing customer_payment for this CM ───────────────────────
  const existing = await financeService.listCustomerPayments(
    { reference: CM_NUMBER, customer_id: cmRow.customer_id },
    { take: 1 }
  );
  if (existing?.length > 0) {
    logger.warn(
      `[fix-cm-1001] customer_payment already exists for ${CM_NUMBER} (id=${existing[0].id}) — nothing to do.`
    );
    return;
  }

  // ─ Planning output ──────────────────────────────────────────────────────────
  logger.info("[fix-cm-1001] Plan:");
  logger.info(
    `  1. UPDATE pos_credit_memo refund_method: '${cmRow.refund_method ?? "NULL"}' → 'refund'`
  );
  logger.info(
    `  2. INSERT customer_payment (type=credit_memo, method=credit_memo, status=refunded, ref=${CM_NUMBER}, amount=${CM_AMOUNT_CENTS})`
  );
  logger.info(
    `  3. QUEUE QB Write Check against AR for $${(CM_AMOUNT_CENTS / 100).toFixed(2)}`
  );
  if (!apply) {
    logger.warn(
      "[fix-cm-1001] DRY RUN — re-run with APPLY=1 to execute the steps above."
    );
    return;
  }

  // ─ 1. Persist refund_method = 'refund' ──────────────────────────────────────
  if (cmRow.refund_method !== "refund") {
    const updateMethodName =
      typeof creditMemoService.updatePosCreditMemos === "function"
        ? "updatePosCreditMemos"
        : typeof creditMemoService.updatePosCreditMemoes === "function"
          ? "updatePosCreditMemoes"
          : null;
    if (!updateMethodName) {
      logger.error(
        "[fix-cm-1001] Could not find updatePosCreditMemo(e)s on service — aborting."
      );
      return;
    }
    await creditMemoService[updateMethodName]({
      id: CM_ID,
      refund_method: "refund",
    });
    logger.info("[fix-cm-1001] ✅ refund_method = 'refund' persisted.");
  }

  // ─ 2. Create customer_payment (mirror of /complete refund path) ────────────
  const seqRes = await pg
    .raw(`SELECT nextval('custom_payment_seq') AS seq`)
    .catch(() => ({ rows: [{ seq: null }] }));
  const nextPayNum = seqRes.rows[0]?.seq
    ? Number(seqRes.rows[0].seq)
    : null;

  const createdPayment = await financeService.createCustomerPayments({
    customer_id: cmRow.customer_id,
    display_id: nextPayNum,
    amount: CM_AMOUNT_CENTS,
    method: "credit_memo",
    reference: CM_NUMBER,
    notes: "Store Credit generated from Return/Credit Memo (data fix)",
    received_at: new Date("2026-04-21T20:34:09.599Z"),
    created_by: "system",
    source: "pos",
    type: "credit_memo",
    status: "available",
    medusa_payment_synced: false,
  });

  const refundMeta = {
    refund_amount: CM_AMOUNT_CENTS,
    refunded_at: new Date().toISOString(),
    refund_notes: `Triggered by CM ${CM_NUMBER} completion (data fix)`,
    refunded_by: "system",
  };
  await pg.raw(
    `UPDATE customer_payment
       SET status = 'refunded', metadata = ?::jsonb
       WHERE id = ?`,
    [JSON.stringify(refundMeta), createdPayment.id]
  );
  logger.info(
    `[fix-cm-1001] ✅ customer_payment created: display_id=${nextPayNum}, id=${createdPayment.id}, status=refunded`
  );

  // ─ 3. Emit QB Write Check ───────────────────────────────────────────────────
  // Resolve QB customer ListID from customer metadata (qb_list_id is the
  // canonical field populated by ensureCustomerInQb on sync).
  const customerRow = await pg("customer")
    .where({ id: cmRow.customer_id })
    .select("metadata")
    .first();
  const metadata = (customerRow?.metadata ?? {}) as Record<string, any>;
  const resolvedQbCustomerId: string | null =
    metadata?.qb_list_id ||
    metadata?.quickbooks_customer_id ||
    metadata?.qb?.customer_id ||
    metadata?.qb_customer_id ||
    null;

  if (!resolvedQbCustomerId) {
    logger.warn(
      "[fix-cm-1001] No QB customer ID on customer metadata — skipping Write Check. You can re-run Write Check manually from accounting."
    );
    logger.info("[fix-cm-1001] DONE (partial — payment created, QB check skipped).");
    return;
  }

  const bankAccountListId = process.env.QB_BANK_ACCOUNT_LIST_ID;
  if (!bankAccountListId) {
    logger.warn(
      "[fix-cm-1001] QB_BANK_ACCOUNT_LIST_ID not set — skipping Write Check. Set the env var and re-run with APPLY=1 to queue the check."
    );
    logger.info("[fix-cm-1001] DONE (partial — payment created, QB check skipped).");
    return;
  }

  try {
    await writePipelineRow({
      referenceId: CM_ID,
      referenceType: "credit_memo",
      step: "write_check",
      status: "pending",
      medusaRefNumber: CM_NUMBER,
      error: null,
    });
    const checkResult = await createCheckInQb({
      customerId: resolvedQbCustomerId,
      bankAccountListId,
      amount: CM_AMOUNT_CENTS / 100,
      date: new Date().toISOString().split("T")[0],
      refNumber: CM_NUMBER,
      memo: `Refund for CM ${CM_NUMBER}`,
      expenseAccountName: "Accounts Receivable",
    });

    if (checkResult.success && checkResult.data?.operationId) {
      await writePipelineRow({
        referenceId: CM_ID,
        referenceType: "credit_memo",
        step: "write_check",
        status: "submitted",
        bridgeOpId: checkResult.data.operationId,
        medusaRefNumber: CM_NUMBER,
      });
      logger.info(
        `[fix-cm-1001] ✅ QB Write Check queued: op=${checkResult.data.operationId}`
      );
    } else {
      await writePipelineRow({
        referenceId: CM_ID,
        referenceType: "credit_memo",
        step: "write_check",
        status: "failed",
        error: checkResult.error || "Write Check creation failed",
      });
      logger.error(
        `[fix-cm-1001] QB Write Check failed: ${checkResult.error}`
      );
    }
  } catch (e: any) {
    logger.error(`[fix-cm-1001] Write Check execution error: ${e.message}`);
  }

  logger.info("[fix-cm-1001] DONE.");
}
