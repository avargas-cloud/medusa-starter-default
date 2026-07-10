import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import { bridgeFetch } from "../client/core";
import { voidCreditMemoInQb } from "../client/credit-memos";
import { voidInvoiceInQb } from "../client/invoices";
import {
  closeSalesOrderInQb,
  reopenSalesOrderInQb,
} from "../client/sales-orders";
import {
  confirmPipelineRow,
  failOrRetryPipelineRow,
  cacheEditSequence,
  claimAndResetForResubmit,
  invalidateEditSequenceCache,
  writePipelineRow,
} from "../qb-pipeline";
import { enqueueEstimateDeactivateIfNeeded } from "../pipeline/enqueue-estimate-deactivate";
import {
  isEditSequenceStaleError,
  refreshEditSequenceForRow,
} from "./refresh-edit-sequence";
import { buildEstimatePatch } from "../qb-metadata-types";
import { resubmitByStep, type ResubmitRow } from "./resubmit-by-step";

const LOG_PREFIX = "[QB-CONSOLIDATOR]";

export type SubmittedRow = {
  id: string;
  order_id: string | null;
  reference_id: string | null;
  reference_type: string | null;
  step: string;
  bridge_op_id: string;
  retry_count: number;
  qb_txn_id: string | null;
};

function compareTxnLineIds(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
  const hexA = parseInt((a ?? "").split("-")[0] ?? a, 16);
  const hexB = parseInt((b ?? "").split("-")[0] ?? b, 16);
  if (!isNaN(hexA) && !isNaN(hexB)) return hexA - hexB;
  return String(a).localeCompare(String(b));
}

export async function pollSubmittedRows(
  submittedRows: SubmittedRow[],
  container: MedusaContainer,
  logger: any
): Promise<void> {
  const pool = getDbPool();

  for (const row of submittedRows) {
    try {
      const statusRes = await bridgeFetch(
        "GET",
        `/api/sync/status/${row.bridge_op_id}`
      );
      const op = statusRes?.operation;

      if (!op) {
        logger.warn(
          `${LOG_PREFIX} No operation data for ${row.bridge_op_id} (row ${row.id})`
        );
        continue;
      }

      if (op.status === "completed") {
        const msgs = op.result?.QBXML?.QBXMLMsgsRs || op.result?.QBXMLMsgsRs;
        const txnId =
          op.txnId ||
          op.result?.TxnID ||
          op.listId ||
          op.result?.ListID ||
          msgs?.CheckAddRs?.CheckRet?.TxnID ||
          msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.TxnID ||
          msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.TxnID ||
          msgs?.CreditMemoAddRs?.CreditMemoRet?.TxnID ||
          null;
        const refNumber =
          op.refNumber ||
          op.result?.RefNumber ||
          msgs?.CheckAddRs?.CheckRet?.RefNumber ||
          msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.RefNumber ||
          msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.RefNumber ||
          msgs?.CreditMemoAddRs?.CreditMemoRet?.RefNumber ||
          null;

        const wonConfirm = await confirmPipelineRow(
          row.id,
          txnId,
          refNumber,
          op.result ?? null
        );
        // CAS: if another poller (consolidator Phase A vs the standalone
        // submitted-poller) already confirmed this row, skip ALL dependent
        // side-effects below (wake-dependents, metadata writes) so they never
        // run twice.
        if (!wonConfirm) {
          continue;
        }

        // EditSequence: prefer the top-level field (set by bridge since fix),
        // fall back to digging into the raw result for older ops
        const editSeq: string | null =
          op.editSequence ||
          op.result?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.EstimateAddRs?.EstimateRet
            ?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.EstimateModRs?.EstimateRet
            ?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderAddRs?.SalesOrderRet
            ?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderModRs?.SalesOrderRet
            ?.EditSequence ||
          op.result?.QBXML?.QBXMLMsgsRs?.InvoiceAddRs?.InvoiceRet
            ?.EditSequence ||
          msgs?.CreditMemoAddRs?.CreditMemoRet?.EditSequence ||
          null;

        // Extract TxnLineID map (productId → [TxnLineID, ...]) from confirmed QB response.
        // Arrays support duplicate products on the same document.
        // Sorted by TxnLineID ascending so the queue matches QB line order.
        const extractLineIds = (
          lineRet: unknown
        ): Record<string, string[]> | null => {
          if (!lineRet) return null;
          const arr: unknown[] = Array.isArray(lineRet) ? lineRet : [lineRet];
          const sorted = [...arr].sort((a, b) =>
            compareTxnLineIds(
              String((a as Record<string, unknown>)?.TxnLineID ?? ""),
              String((b as Record<string, unknown>)?.TxnLineID ?? "")
            )
          );
          const map: Record<string, string[]> = {};
          for (const line of sorted) {
            const l = line as Record<string, unknown>;
            const pid = (l?.ItemRef as Record<string, unknown>)?.ListID as
              | string
              | undefined;
            const tid = l?.TxnLineID as string | undefined;
            if (pid && tid) {
              if (!map[pid]) map[pid] = [];
              map[pid].push(tid);
            }
          }
          return Object.keys(map).length > 0 ? map : null;
        };

        const lineIds: Record<string, string[]> | null =
          extractLineIds(
            op.result?.QBXML?.QBXMLMsgsRs?.EstimateAddRs?.EstimateRet
              ?.EstimateLineRet
          ) ??
          extractLineIds(
            op.result?.QBXML?.QBXMLMsgsRs?.EstimateModRs?.EstimateRet
              ?.EstimateLineRet
          ) ??
          extractLineIds(
            op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderAddRs?.SalesOrderRet
              ?.SalesOrderLineRet
          ) ??
          extractLineIds(
            op.result?.QBXML?.QBXMLMsgsRs?.SalesOrderModRs?.SalesOrderRet
              ?.SalesOrderLineRet
          ) ??
          extractLineIds(
            msgs?.CreditMemoAddRs?.CreditMemoRet?.CreditMemoLineRet
          ) ??
          extractLineIds(
            msgs?.CreditMemoModRs?.CreditMemoRet?.CreditMemoLineRet
          ) ??
          null;

        // Cache EditSequence (+ TxnLineIDs when available) so next mod can skip the GET round-trip
        if (editSeq && txnId) {
          await cacheEditSequence(
            row.step,
            txnId,
            editSeq,
            lineIds ?? undefined
          );
        }

        // inventory_adjustment confirmed → stamp qb_synced_at on the inventory_count
        if (row.step === "inventory_adjustment" && row.order_id) {
          try {
            await pool.query(
              `UPDATE inventory_count SET qb_synced_at = NOW() WHERE id = $1`,
              [row.order_id]
            );
            logger.info(
              `${LOG_PREFIX} ✅ inventory_count ${row.order_id} → qb_synced_at stamped (TxnID=${txnId})`
            );
          } catch (icErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not stamp qb_synced_at on inventory_count ${row.order_id}: ${icErr.message}`
            );
          }
        }

        // sales_receipt / invoice confirmed via async poll → propagate qb_sync_status='synced'
        // to pos_invoice.metadata AND clear stale 'error' on order.metadata.
        if (
          txnId &&
          (row.step === "sales_receipt" || row.step === "invoice") &&
          row.reference_id
        ) {
          try {
            await pool.query(
              `UPDATE pos_invoice
                             SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                             WHERE id = $1`,
              [
                row.reference_id,
                JSON.stringify({
                  qb_txn_id: txnId,
                  qb_ref_number: refNumber,
                  qb_sync_status: "synced",
                }),
              ]
            );
            logger.info(
              `${LOG_PREFIX} ✅ Synced pos_invoice ${row.reference_id} → qb_sync_status='synced', TxnID=${txnId}`
            );
          } catch (posInvErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update pos_invoice metadata: ${posInvErr.message}`
            );
          }

          // VOID-BEFORE-CREATE RACE GUARD (2026-07-01): if the invoice was voided
          // in Medusa BEFORE its QB create confirmed, handle-invoice-voided found no
          // qb_txn_id (order.metadata.qb_invoices was empty) and no-op'd — leaving
          // the QB doc created afterwards and orphaned/open with no void. Now that the
          // create confirmed and we know the TxnID, auto-enqueue the void so the
          // consolidator voids it in QB. Idempotent: skips if a void row already exists.
          try {
            const { rows: invRows } = await pool.query(
              `SELECT status, metadata->>'is_sales_receipt' AS is_sr
                 FROM pos_invoice WHERE id = $1`,
              [row.reference_id]
            );
            const invRow = invRows[0];
            if (invRow?.status === "voided") {
              const voidStep =
                invRow.is_sr === "true" ? "void_sales_receipt" : "void_invoice";
              const { rows: existingVoid } = await pool.query(
                `SELECT id FROM qb_order_pipeline
                   WHERE reference_id = $1
                     AND step IN ('void_invoice', 'void_sales_receipt')
                   LIMIT 1`,
                [row.reference_id]
              );
              if (existingVoid.length === 0) {
                await writePipelineRow({
                  orderId: row.order_id ?? null,
                  referenceId: row.reference_id,
                  referenceType: "pos_invoice",
                  step: voidStep,
                  status: "pending",
                  qbTxnId: txnId,
                  qbRefNumber: refNumber ?? null,
                  medusaRefNumber: refNumber ?? row.reference_id,
                });
                logger.info(
                  `${LOG_PREFIX} ⚠️ pos_invoice ${row.reference_id} was voided before its QB create confirmed — auto-enqueued ${voidStep} for TxnID=${txnId}`
                );
              }
            }
          } catch (voidRaceErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not check/enqueue post-confirm void for pos_invoice ${row.reference_id}: ${voidRaceErr.message}`
            );
          }

          // Propagate synced status to customer_payment rows linked via invoices_affected
          try {
            const cpResult = await pool.query(
              `UPDATE customer_payment
               SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                   qb = $3::jsonb
               WHERE metadata->'invoices_affected' @> to_jsonb($1::text)
                 AND metadata->>'is_sales_receipt_payment' = 'true'
                 AND COALESCE(metadata->>'qb_sync_status', '') != 'synced'`,
              [
                row.reference_id,
                JSON.stringify({ qb_sync_status: "synced" }),
                JSON.stringify({ source: "sales_receipt", status: "yes" }),
              ]
            );
            if ((cpResult.rowCount ?? 0) > 0) {
              logger.info(
                `${LOG_PREFIX} ✅ Propagated SR sync to ${cpResult.rowCount} customer_payment(s) for pos_invoice ${row.reference_id}`
              );
            }
          } catch (cpErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not propagate SR sync to customer_payment: ${cpErr.message}`
            );
          }

          if (row.order_id) {
            try {
              await pool.query(
                `UPDATE "order"
                                 SET metadata = metadata || '{"qb_sync_status":"child_synced"}'::jsonb
                                 WHERE id = $1 AND metadata->>'qb_sync_status' = 'error'`,
                [row.order_id]
              );
            } catch (ordErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not clear stale qb_sync_status='error' on order ${row.order_id}: ${ordErr.message}`
              );
            }
          }
        }

        // Section 1.5.14: void_invoice / void_sales_receipt confirmed → mark
        // pos_invoice.metadata.qb_sync_status='voided_in_qb' so UI badge flips.
        if (
          (row.step === "void_invoice" ||
            row.step === "void_sales_receipt") &&
          row.reference_id
        ) {
          try {
            await pool.query(
              `UPDATE pos_invoice
                             SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                             WHERE id = $1`,
              [
                row.reference_id,
                JSON.stringify({ qb_sync_status: "voided_in_qb" }),
              ]
            );
            logger.info(
              `${LOG_PREFIX} ✅ Synced pos_invoice ${row.reference_id} → qb_sync_status='voided_in_qb' (${row.step})`
            );
          } catch (posInvErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update pos_invoice voided metadata: ${posInvErr.message}`
            );
          }
          if (row.order_id) {
            try {
              await pool.query(
                `UPDATE "order"
                                 SET metadata = metadata || '{"qb_sync_status":"voided"}'::jsonb
                                 WHERE id = $1`,
                [row.order_id]
              );
            } catch (ordErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not stamp order qb_sync_status='voided' on ${row.order_id}: ${ordErr.message}`
              );
            }
          }
        }

        // Section 1.5.14: void_check confirmed → mark customer_payment qb.status='voided'.
        if (row.step === "void_check" && row.reference_id) {
          try {
            await pool.query(
              `UPDATE customer_payment
                             SET qb = COALESCE(qb, '{}'::jsonb) || '{"status":"voided"}'::jsonb
                             WHERE id = $1`,
              [row.reference_id]
            );
            logger.info(
              `${LOG_PREFIX} ✅ Synced customer_payment ${row.reference_id} → qb.status='voided' (void_check)`
            );
          } catch (cpErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update customer_payment voided metadata: ${cpErr.message}`
            );
          }
        }

        if (
          txnId &&
          (row.step === "credit_memo" || row.step === "credit_memo_mod") &&
          row.reference_id
        ) {
          if (row.step === "credit_memo") {
            try {
              await pool.query(
                `UPDATE pos_credit_memo
                               SET qb_txn_id = $2, qb_edit_sequence = $3
                               WHERE id = $1`,
                [row.reference_id, txnId, editSeq ?? null]
              );
              logger.info(
                `${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} + editSeq to pos_credit_memo ${row.reference_id}`
              );
            } catch (cmErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not update pos_credit_memo: ${cmErr.message}`
              );
            }
          } else if (row.step === "credit_memo_mod" && editSeq) {
            // Refresh stored EditSequence after a successful MOD so the next
            // MOD round does not need to query QB for it.
            try {
              await pool.query(
                `UPDATE pos_credit_memo SET qb_edit_sequence = $2 WHERE id = $1`,
                [row.reference_id, editSeq]
              );
              logger.info(
                `${LOG_PREFIX} ✅ Refreshed qb_edit_sequence on pos_credit_memo ${row.reference_id} after mod`
              );
            } catch (modErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not refresh editSeq after credit_memo_mod: ${modErr.message}`
              );
            }
          }

          // Persist per-line TxnLineID on pos_credit_memo_item so future
          // CreditMemoMod requests can address individual lines (update vs
          // add vs delete). Match by QB ItemRef.ListID → variant.metadata.quickbooks_id
          // ordering: QB returns lines in submission order, we update the
          // earliest matching row that does not yet have a qb_txn_line_id.
          if (lineIds) {
            try {
              for (const [qbListId, txnLineIds] of Object.entries(lineIds)) {
                for (const txnLineId of txnLineIds) {
                  await pool.query(
                    `UPDATE pos_credit_memo_item
                     SET qb_txn_line_id = $3
                     WHERE id = (
                       SELECT cmi.id FROM pos_credit_memo_item cmi
                       LEFT JOIN product_variant pv ON pv.id = cmi.variant_id
                       WHERE cmi.credit_memo_id = $1
                         AND cmi.qb_txn_line_id IS DISTINCT FROM $3
                         AND COALESCE(pv.metadata->>'quickbooks_id', '') = $2
                       ORDER BY cmi.id ASC
                       LIMIT 1
                     )`,
                    [row.reference_id, qbListId, txnLineId]
                  );
                }
              }
              logger.info(
                `${LOG_PREFIX} ✅ Persisted TxnLineIDs to pos_credit_memo_item rows for CM ${row.reference_id}`
              );
            } catch (lineErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not persist TxnLineIDs for CM ${row.reference_id}: ${lineErr.message}`
              );
            }
          }

          // Also propagate qb_txn_id to the customer_payment (store credit) derived
          // from this credit memo — so it can be used as a QB credit when applying
          // to a future invoice via POST /api/payments/{qb_txn_id}/apply
          try {
            const { rows: cmRows } = await pool.query(
              `SELECT credit_memo_number FROM pos_credit_memo WHERE id = $1`,
              [row.reference_id]
            );
            const cmNumber = cmRows[0]?.credit_memo_number;
            if (cmNumber) {
              const { rowCount } = await pool.query(
                `UPDATE customer_payment
                                 SET metadata = COALESCE(metadata, '{}') || $2::jsonb
                                 WHERE reference = $1
                                   AND (metadata->>'qb_txn_id') IS NULL`,
                [
                  cmNumber,
                  JSON.stringify({
                    qb_txn_id: txnId,
                    qb_sync_status: "synced",
                  }),
                ]
              );
              if (rowCount && rowCount > 0) {
                logger.info(
                  `${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} to customer_payment linked to ${cmNumber}`
                );
              }
            }
          } catch (cpErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not propagate qb_txn_id to customer_payment: ${cpErr.message}`
            );
          }
        }

        // credit_memo confirmed → activate any waiting void_credit_memo rows
        if (txnId && row.step === "credit_memo" && row.reference_id) {
          try {
            const { rows: waitingVoidCms } = await pool.query(
              `SELECT id FROM qb_order_pipeline
                             WHERE depends_on = $1 AND status = 'waiting' AND step = 'void_credit_memo'`,
              [row.id]
            );
            for (const vcRow of waitingVoidCms) {
              try {
                const vcResult = await voidCreditMemoInQb(
                  txnId,
                  editSeq ?? null,
                  (m) => logger.info(m)
                );
                if (vcResult.success && vcResult.data?.operationId) {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3, submitted_at = NOW()
                                         WHERE id = $1`,
                    [vcRow.id, vcResult.data.operationId, txnId]
                  );
                  logger.info(
                    `${LOG_PREFIX} ✅ Activated waiting void_credit_memo ${vcRow.id} → op ${vcResult.data.operationId}`
                  );
                } else {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'failed', error = $2, qb_txn_id = $3, failed_at = NOW()
                                         WHERE id = $1`,
                    [vcRow.id, vcResult.error ?? "QB CM void failed", txnId]
                  );
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Failed to activate void_credit_memo ${vcRow.id}: ${vcResult.error}`
                  );
                }
              } catch (vcErr: any) {
                logger.warn(
                  `${LOG_PREFIX} ⚠️ Error activating void_credit_memo ${vcRow.id}: ${vcErr.message}`
                );
              }
            }
          } catch (vcListErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error querying waiting void_credit_memo rows: ${vcListErr.message}`
            );
          }
        }

        // write_check confirmed → update CustomerPayment.qb and activate waiting refund_payment rows
        if (row.step === "write_check" && row.reference_id) {
          try {
            await pool.query(
              `UPDATE customer_payment
                             SET qb = $2::jsonb
                             WHERE id = $1`,
              [
                row.reference_id,
                JSON.stringify({ status: "yes", check_txn_id: txnId ?? null }),
              ]
            );
            logger.info(
              `${LOG_PREFIX} ✅ write_check confirmed → CustomerPayment ${row.reference_id} qb.status=yes`
            );
          } catch (wcErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update CustomerPayment qb after write_check: ${wcErr.message}`
            );
          }

          // Activate waiting refund_payment rows (ALL refund types)
          if (txnId) {
            try {
              const { rows: rpRows } = await pool.query(
                `SELECT rp.id, rp.reference_id, rp.payload
                                 FROM qb_order_pipeline rp
                                 WHERE rp.step = 'refund_payment'
                                   AND rp.status = 'waiting'
                                   AND rp.depends_on = $1`,
                [row.id]
              );
              for (const rpRow of rpRows) {
                try {
                  const rpPayload = rpRow.payload ?? {};
                  const { rows: cpRows } = await pool.query(
                    `SELECT cp.reference, cp.amount, cp.metadata,
                                                cp.batch_day,
                                                cust.metadata->>'qb_list_id' AS customer_list_id
                                         FROM customer_payment cp
                                         JOIN customer cust ON cust.id = cp.customer_id
                                         WHERE cp.id = $1`,
                    [rpRow.reference_id]
                  );
                  const cp = cpRows[0];
                  if (!cp?.customer_list_id) {
                    logger.warn(
                      `${LOG_PREFIX} ⚠️ No customer QB ListID for refund_payment ${rpRow.id}`
                    );
                    continue;
                  }

                  let creditTxnId: string | null = null;

                  if (rpPayload.type === "credit_memo") {
                    const { rows: cmRows } = await pool.query(
                      `SELECT qb_txn_id FROM pos_credit_memo WHERE credit_memo_number = $1`,
                      [cp.reference]
                    );
                    creditTxnId = cmRows[0]?.qb_txn_id ?? null;
                    if (!creditTxnId) {
                      logger.warn(
                        `${LOG_PREFIX} ⚠️ No QB TxnID for credit memo ${cp.reference} — refund_payment skipped`
                      );
                      continue;
                    }
                  } else {
                    creditTxnId =
                      rpPayload.originalPaymentTxnId ??
                      cp.metadata?.qb_txn_id ??
                      null;
                    if (!creditTxnId) {
                      logger.warn(
                        `${LOG_PREFIX} ⚠️ No original ReceivePayment TxnID for refund_payment ${rpRow.id} — skipping`
                      );
                      continue;
                    }
                  }

                  const refundAmount = cp.metadata?.refund_amount
                    ? Number(cp.metadata.refund_amount)
                    : Number(cp.amount);
                  const amountDollars = Number(refundAmount / 100).toFixed(2);

                  // Explicit TxnDate (durable rule: EVERY ReceivePayment
                  // callsite sends one) — refund date chosen at process time,
                  // batch_day fallback for legacy rows without payload.txnDate.
                  const rpTxnDate =
                    (rpPayload.txnDate as string | undefined) ??
                    (cp.batch_day as string | undefined) ??
                    undefined;

                  const rpRes = await bridgeFetch("POST", "/api/sync/enqueue", {
                    type: "receive-payment",
                    action: "add",
                    data: {
                      customerId: cp.customer_list_id,
                      invoiceId: txnId,
                      creditTxnId: creditTxnId,
                      amount: Number(amountDollars),
                      totalAmount: 0,
                      paymentAmount: 0,
                      ...(rpTxnDate ? { date: rpTxnDate } : {}),
                    },
                  });
                  if (!rpRes?.operation_id) {
                    logger.warn(
                      `${LOG_PREFIX} ⚠️ Bridge did not return operation_id for refund_payment ${rpRow.id}`
                    );
                    continue;
                  }
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW()
                                         WHERE id = $1`,
                    [rpRow.id, rpRes.operation_id]
                  );
                  logger.info(
                    `${LOG_PREFIX} ✅ refund_payment ${rpRow.id} activated (${rpPayload.type ?? "direct"}) → bridge op ${rpRes.operation_id}`
                  );
                } catch (rpErr: any) {
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Failed to activate refund_payment ${rpRow.id}: ${rpErr.message}`
                  );
                }
              }
            } catch (rpListErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Error querying refund_payment rows: ${rpListErr.message}`
              );
            }
          }
        }

        // refund_check_mod confirmed → NOW reflect the new bank on the
        // confirmed write_check row's payload (deliberately deferred: updating
        // it at enqueue time would make the UI claim a bank QB hasn't accepted).
        if (row.step === "refund_check_mod" && row.reference_id) {
          try {
            const { rows: modSelfRows } = await pool.query(
              `SELECT payload FROM qb_order_pipeline WHERE id = $1`,
              [row.id]
            );
            const modBankId = modSelfRows[0]?.payload?.bankAccountId as
              | string
              | undefined;
            if (modBankId) {
              await pool.query(
                `UPDATE qb_order_pipeline
                    SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb,
                        updated_at = NOW()
                  WHERE step = 'write_check' AND reference_id = $1
                    AND status = 'confirmed'`,
                [row.reference_id, JSON.stringify({ bankAccountId: modBankId })]
              );
              logger.info(
                `${LOG_PREFIX} ✅ refund_check_mod confirmed → write_check payload bank=${modBankId} for ${row.reference_id}`
              );
            }
          } catch (rcmErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not propagate refund_check_mod bank to write_check payload: ${rcmErr.message}`
            );
          }
        }

        if (txnId && row.step === "payment" && row.reference_id) {
          try {
            const { rows: cpRows } = await pool.query(
              `SELECT metadata FROM customer_payment WHERE id = $1`,
              [row.reference_id]
            );
            const cpMeta = cpRows[0]?.metadata || {};
            if (!cpMeta.qb_txn_id) {
              await pool.query(
                `UPDATE customer_payment
                                 SET metadata = COALESCE(metadata, '{}') || $2::jsonb
                                 WHERE id = $1`,
                [
                  row.reference_id,
                  JSON.stringify({
                    qb_txn_id: txnId,
                    qb_sync_status: "synced",
                  }),
                ]
              );
              logger.info(
                `${LOG_PREFIX} ✅ Wrote qb_txn_id=${txnId} to customer_payment ${row.reference_id}`
              );
            }
          } catch (cpErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update customer_payment metadata: ${cpErr.message}`
            );
          }
        }

        // transfer_customer confirmed → write new editSequence to order metadata
        if (row.step === "transfer_customer" && row.order_id) {
          try {
            if (editSeq) {
              const orderModule = container.resolve(Modules.ORDER);
              const { rows: metaRows } = await pool.query(
                `SELECT metadata FROM "order" WHERE id = $1`,
                [row.order_id]
              );
              const existingMeta = metaRows[0]?.metadata || {};

              const refType = (row as any).reference_type as string | null;
              let patch = existingMeta;
              if (refType === "sales_order") {
                const existing = existingMeta.qb_sales_order || {};
                patch = {
                  ...existingMeta,
                  qb_sales_order: { ...existing, edit_sequence: editSeq },
                  qb_sales_order_edit_sequence: editSeq,
                };
              } else if (refType === "invoice") {
                const invoices = Array.isArray(existingMeta.qb_invoices)
                  ? existingMeta.qb_invoices
                  : [];
                if (invoices.length > 0) {
                  const updated = [...invoices];
                  updated[updated.length - 1] = {
                    ...updated[updated.length - 1],
                    edit_sequence: editSeq,
                  };
                  patch = {
                    ...existingMeta,
                    qb_invoices: updated,
                    qb_invoice_edit_sequence: editSeq,
                  };
                }
              }

              await orderModule.updateOrders(row.order_id, { metadata: patch });
              logger.info(
                `${LOG_PREFIX} ✅ transfer_customer confirmed — updated editSeq for ${refType} on order ${row.order_id}`
              );
            } else {
              logger.info(
                `${LOG_PREFIX} ℹ️ transfer_customer confirmed but no editSeq in response — metadata unchanged`
              );
            }
          } catch (tcErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update order metadata after transfer_customer: ${tcErr.message}`
            );
          }
        }

        // so_close / so_reopen confirmed → activate any waiting dependent rows
        if (row.step === "so_close" || row.step === "so_reopen") {
          try {
            const { rows: waitingRows } = await pool.query(
              `SELECT id, step, order_id FROM qb_order_pipeline
                             WHERE depends_on = $1 AND status = 'waiting'
                               AND step IN ('so_close', 'so_reopen')`,
              [row.id]
            );
            for (const waitingRow of waitingRows) {
              try {
                const { rows: orderRows } = await pool.query(
                  `SELECT metadata FROM "order" WHERE id = $1`,
                  [waitingRow.order_id]
                );
                const wMeta = orderRows[0]?.metadata || {};
                const wSoTxnId: string | undefined =
                  (wMeta.qb_sales_order as any)?.txn_id ||
                  wMeta.qb_so_txn_id ||
                  wMeta.qb_sales_order_txn_id;
                if (!wSoTxnId) {
                  logger.warn(
                    `${LOG_PREFIX} No soTxnId for waiting ${waitingRow.step} ${waitingRow.id} — skipping`
                  );
                  continue;
                }
                const wResult =
                  waitingRow.step === "so_close"
                    ? await closeSalesOrderInQb(wSoTxnId, (m) => logger.info(m))
                    : await reopenSalesOrderInQb(wSoTxnId, (m) =>
                        logger.info(m)
                      );
                if (wResult.success && wResult.data?.operationId) {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'submitted', bridge_op_id = $2, submitted_at = NOW()
                                         WHERE id = $1`,
                    [waitingRow.id, wResult.data.operationId]
                  );
                  logger.info(
                    `${LOG_PREFIX} ✅ Activated waiting ${waitingRow.step} ${waitingRow.id} → op ${wResult.data.operationId}`
                  );
                } else {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'failed', error = $2, failed_at = NOW()
                                         WHERE id = $1`,
                    [waitingRow.id, wResult.error ?? "QB sync failed"]
                  );
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Failed to activate ${waitingRow.step} ${waitingRow.id}: ${wResult.error}`
                  );
                }
              } catch (wErr: any) {
                logger.warn(
                  `${LOG_PREFIX} ⚠️ Error activating waiting ${waitingRow.step} ${waitingRow.id}: ${wErr.message}`
                );
              }
            }
          } catch (soDepErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error querying waiting so_close/so_reopen rows: ${soDepErr.message}`
            );
          }
        }

        // sales_order/estimate confirmed with txnId → activate waiting void rows
        if (txnId && (row.step === "sales_order" || row.step === "estimate")) {
          try {
            const { rows: waitingVoids } = await pool.query(
              `SELECT id, step FROM qb_order_pipeline
                             WHERE depends_on = $1 AND status = 'waiting'
                               AND step IN ('void_sales_order', 'void_invoice')`,
              [row.id]
            );
            for (const voidRow of waitingVoids) {
              try {
                const vResult =
                  voidRow.step === "void_invoice"
                    ? await voidInvoiceInQb(txnId, (m) => logger.info(m))
                    : await closeSalesOrderInQb(txnId, (m) => logger.info(m));
                if (vResult.success && vResult.data?.operationId) {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'submitted', bridge_op_id = $2, qb_txn_id = $3, submitted_at = NOW()
                                         WHERE id = $1`,
                    [voidRow.id, vResult.data.operationId, txnId]
                  );
                  logger.info(
                    `${LOG_PREFIX} ✅ Activated waiting ${voidRow.step} ${voidRow.id} → op ${vResult.data.operationId}`
                  );
                } else {
                  await pool.query(
                    `UPDATE qb_order_pipeline
                                         SET status = 'failed', error = $2, qb_txn_id = $3, failed_at = NOW()
                                         WHERE id = $1`,
                    [voidRow.id, vResult.error ?? "QB void failed", txnId]
                  );
                  logger.warn(
                    `${LOG_PREFIX} ⚠️ Failed to activate ${voidRow.step} ${voidRow.id}: ${vResult.error}`
                  );
                }
              } catch (vErr: any) {
                logger.warn(
                  `${LOG_PREFIX} ⚠️ Error activating waiting ${voidRow.step} ${voidRow.id}: ${vErr.message}`
                );
              }
            }
          } catch (voidDepErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error querying waiting void rows: ${voidDepErr.message}`
            );
          }
        }

        // sales_order confirmed → deactivate the order's converted Estimate so it
        // drops off QB's "Open Estimates" list. See enqueueEstimateDeactivateIfNeeded.
        if (txnId && row.step === "sales_order" && row.order_id) {
          try {
            await enqueueEstimateDeactivateIfNeeded(row.order_id, (m) =>
              logger.info(`${LOG_PREFIX} ${m}`)
            );
          } catch (deactEnqErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not enqueue estimate_deactivate for order ${row.order_id}: ${deactEnqErr.message}`
            );
          }
        }

        if (txnId && row.order_id && row.step !== "transfer_customer") {
          try {
            const orderModule = container.resolve(Modules.ORDER);
            const { rows: metaRows } = await pool.query(
              `SELECT metadata FROM "order" WHERE id = $1`,
              [row.order_id]
            );
            const existingMeta = metaRows[0]?.metadata || {};

            let patch: Record<string, any>;
            if (row.step === "estimate") {
              patch = buildEstimatePatch(existingMeta, {
                txnId,
                refNumber,
                operationId: null,
                editSequence: editSeq,
                syncStatus: "synced",
              });
            } else if (row.step === "sales_order" && txnId) {
              const existing =
                (existingMeta.qb_sales_order as
                  | Record<string, any>
                  | undefined) || {};
              patch = {
                ...existingMeta,
                qb_sales_order: {
                  ...existing,
                  txn_id: txnId,
                  ref_number: refNumber || existing.ref_number || null,
                  operation_id: null,
                  edit_sequence: editSeq || existing.edit_sequence || null,
                  synced_at: new Date().toISOString(),
                },
                qb_sales_order_txn_id: txnId,
                qb_sync_status: "sales_order",
              };
            } else {
              if (!editSeq) {
                logger.info(
                  `${LOG_PREFIX} ℹ️ No metadata update needed for step=${row.step} (no editSequence)`
                );
                continue;
              }
              const stepKey = row.step === "invoice" ? "qb_invoices" : null;
              if (stepKey === null) {
                patch = existingMeta;
              } else {
                patch = existingMeta;
              }
            }

            await orderModule.updateOrders(row.order_id, { metadata: patch });
            logger.info(
              `${LOG_PREFIX} ✅ Updated order ${row.order_id} metadata — step=${row.step}, TxnID=${txnId}, editSequence=${editSeq ? "✓" : "—"}`
            );
          } catch (metaErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not update order metadata for ${row.order_id}: ${metaErr.message}`
            );
          }
        }

        logger.info(
          `${LOG_PREFIX} ✅ Confirmed row ${row.id} (${row.step}) — TxnID=${txnId}, Ref=${refNumber}`
        );

        // next_payload coalescing: if a save arrived while this row was in-flight,
        // reset the same row to 'pending' and re-submit immediately.
        try {
          const hasCoalesced = await claimAndResetForResubmit(row.id);
          if (hasCoalesced) {
            logger.info(
              `${LOG_PREFIX} ⏩ Coalesced save detected for row ${row.id} (${row.step}) — resubmitting`
            );
            await resubmitByStep(row as ResubmitRow, container, logger);
          }
        } catch (resubErr: any) {
          logger.warn(
            `${LOG_PREFIX} ⚠️ Could not process coalesced save for row ${row.id}: ${resubErr.message}`
          );
        }
      } else if (op.status === "failed") {
        const errMsg = op.error || "QB operation failed (no details)";
        const decision = await failOrRetryPipelineRow(
          row.id,
          errMsg,
          row.retry_count ?? 0
        );
        // Invalidate cached EditSequence — but only when the error implies
        // the cached value is wrong. Error 3175 ("transaction locked") means
        // QB never touched the document, so the cache is still valid.
        const isLockedError =
          errMsg.includes("3175") || errMsg.includes("could not be locked");
        if (row.qb_txn_id && !isLockedError) {
          await invalidateEditSequenceCache(
            row.step as string,
            row.qb_txn_id as string
          ).catch(() => {});
        }

        // Auto-heal: when the failure is a stale EditSequence on a *_mod step
        // and the retry budget still has room, fetch the current EditSequence
        // from QB and write it onto the owning row (e.g. pos_credit_memo).
        // Without this, the next consolidator tick reads the same stale value
        // from the DB fallback and the row spins in a 3200/3210 retry loop.
        if (
          decision.nextRetryAt &&
          row.qb_txn_id &&
          isEditSequenceStaleError(errMsg)
        ) {
          await refreshEditSequenceForRow(
            row.step as string,
            row.qb_txn_id as string,
            (row.reference_id as string | null) ?? null,
            logger,
            row.id as string
          ).catch((healErr: unknown) => {
            const msg =
              healErr instanceof Error ? healErr.message : String(healErr);
            logger.warn(
              `${LOG_PREFIX} ⚠️ Auto-heal threw for row ${row.id}: ${msg}`
            );
          });
        }

        logger.warn(
          `${LOG_PREFIX} ❌ Row ${row.id} (${row.step}) → ${decision.newStatus} (${decision.classification.class}, retry ${decision.newRetries}): ${errMsg}`
        );

        // Cascade-fail / skip-dependent logic only fires on terminal failure.
        // Retryable failures are also `failed`, but carry `next_retry_at`;
        // dependents must keep waiting until the retry budget is exhausted.
        if (decision.nextRetryAt) {
          continue;
        }

        // so_close/so_reopen failed → cascade-fail any waiting dependent rows
        if (row.step === "so_close" || row.step === "so_reopen") {
          try {
            const { rowCount } = await pool.query(
              `UPDATE qb_order_pipeline
                             SET status       = 'failed',
                                 error        = $2,
                                 failed_at    = NOW(),
                                 confirmed_at = NULL,
                                 updated_at   = NOW()
                             WHERE depends_on = $1 AND status = 'waiting'
                               AND step IN ('so_close', 'so_reopen')`,
              [row.id, `Dependency ${row.id} (${row.step}) failed`]
            );
            if (rowCount && rowCount > 0) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Cascade-failed ${rowCount} waiting row(s) dependent on ${row.id}`
              );
            }
          } catch (cascErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error cascade-failing dependents: ${cascErr.message}`
            );
          }
        }

        // credit_memo failed → skip waiting void_credit_memo rows
        if (row.step === "credit_memo" && row.reference_id) {
          try {
            const { rowCount: vcSkipCount } = await pool.query(
              `UPDATE qb_order_pipeline
                             SET status       = 'skipped',
                                 error        = $2,
                                 submitted_at = NULL,
                                 confirmed_at = NULL,
                                 failed_at    = NULL,
                                 updated_at   = NOW()
                             WHERE depends_on = $1 AND status = 'waiting' AND step = 'void_credit_memo'`,
              [row.id, `Skipped — parent credit_memo never reached QB`]
            );
            if (vcSkipCount && vcSkipCount > 0) {
              logger.info(
                `${LOG_PREFIX} ℹ️ Skipped ${vcSkipCount} waiting void_credit_memo row(s) — parent failed`
              );
            }
          } catch (vcsfErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error skipping void_credit_memo rows: ${vcsfErr.message}`
            );
          }
        }

        // sales_order/estimate failed → skip any waiting void rows
        if (row.step === "sales_order" || row.step === "estimate") {
          try {
            const { rowCount: skipCount } = await pool.query(
              `UPDATE qb_order_pipeline
                             SET status       = 'skipped',
                                 error        = $2,
                                 submitted_at = NULL,
                                 confirmed_at = NULL,
                                 failed_at    = NULL,
                                 updated_at   = NOW()
                             WHERE depends_on = $1 AND status = 'waiting'
                               AND step IN ('void_sales_order', 'void_invoice')`,
              [row.id, `Skipped — parent ${row.step} never reached QB`]
            );
            if (skipCount && skipCount > 0) {
              logger.info(
                `${LOG_PREFIX} ℹ️ Skipped ${skipCount} waiting void row(s) — parent ${row.step} failed`
              );
            }
          } catch (svErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Error skipping void rows after parent failure: ${svErr.message}`
            );
          }
        }
      } else {
        // Still pending/processing on bridge side — nothing to do yet
        logger.info(
          `${LOG_PREFIX} ⏳ Row ${row.id} (${row.step}) bridge status: ${op.status}`
        );
      }
    } catch (pollErr: any) {
      logger.warn(
        `${LOG_PREFIX} ⚠️ Error polling row ${row.id} op ${row.bridge_op_id}: ${pollErr.message}`
      );
    }
  }
}
