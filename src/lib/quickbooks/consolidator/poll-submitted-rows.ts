import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import { performMedusaRefundRevert } from "../../finance/revert-refund";
import {
  reconcileReceiptModIfDrifted,
  type KnexRaw,
} from "../../purchase-orders/item-receipt-mod-payload";
import {
  CM_SYNTHETIC_LINE_IDS_META_KEY,
  extractQbSyntheticLineIds,
} from "../credit-memo-synthetic-lines";
import { bridgeFetch } from "../client/core";
import { voidCreditMemoInQb } from "../client/credit-memos";
import { voidInvoiceInQb } from "../client/invoices";
import {
  closeSalesOrderInQb,
  reopenSalesOrderInQb,
} from "../client/sales-orders";
import { deactivateEstimateInQb } from "../client/estimates";
import {
  confirmPipelineRow,
  failPipelineRow,
  failOrRetryPipelineRow,
  cacheEditSequence,
  claimAndResetForResubmit,
  invalidateEditSequenceCache,
} from "../qb-pipeline";
import { enqueueEstimateDeactivateIfNeeded } from "../pipeline/enqueue-estimate-deactivate";
import { enqueueVoidIfAlreadyVoided } from "../pipeline/void-intent";
import {
  isQbObjectNotFound,
  qbStatusMessage,
  settleBillMissingInQb,
} from "../pipeline/vendor-bill-missing";
import {
  isEditSequenceStaleError,
  refreshEditSequenceForRow,
  stepToCacheEntityType,
} from "./refresh-edit-sequence";
import {
  canHealLineOrder,
  healLineOrderForRow,
  isLineOrderError,
} from "./heal-line-order";
import { buildEstimatePatch } from "../qb-metadata-types";
import { resubmitByStep, type ResubmitRow } from "./resubmit-by-step";
import { activateRefundPaymentRow } from "./refund-payment-activation";
import {
  completePurchaseAddExistenceCheck,
  completePurchaseOperation,
  isPurchaseOperationStep,
  mirrorPurchaseOperationFailure,
  PURCHASE_EXISTENCE_CHECK_KEY,
  schedulePurchaseAddExistenceCheck,
} from "./purchase-operations";
import {
  completeVendorBillRebuildDelete,
  isAlreadyMissingBillDeleteError,
  PermanentPurchaseOperationError,
} from "./vendor-bill-rebuild-operations";
import { classifyQbError } from "../error-classifier";

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
  payload?: Record<string, unknown> | null;
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

function extractVendorBillQueryRet(msgs: any, txnId: string | null): any | null {
  const raw = msgs?.BillQueryRs?.BillRet;
  const bills = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  return (
    bills.find((bill: any) => String(bill?.TxnID ?? "") === String(txnId ?? "")) ??
    bills[0] ??
    null
  );
}

function vendorBillIsPaid(bill: any): boolean {
  const raw = bill?.IsPaid;
  if (raw === true || raw === "true" || raw === "1") return true;
  const amountDue = Number(bill?.AmountDue);
  return Number.isFinite(amountDue) && amountDue <= 0;
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
        let purchaseCompletion:
          | Awaited<ReturnType<typeof completePurchaseOperation>>
          | null = null;
        if (isPurchaseOperationStep(row.step)) {
          try {
            if (row.payload?.[PURCHASE_EXISTENCE_CHECK_KEY] === true) {
              purchaseCompletion =
                await completePurchaseAddExistenceCheck(
                  row as ResubmitRow,
                  op as Record<string, unknown>
                );
              if (!purchaseCompletion) {
                logger.info(
                  `${LOG_PREFIX} 🔎 ${row.step} ${row.id} verified absent in QuickBooks — Add is now safe to dispatch`
                );
                continue;
              }
              logger.warn(
                `${LOG_PREFIX} ♻️ ${row.step} ${row.id} already existed in QuickBooks after a lost response — adopted without duplicate Add`
              );
            } else {
              purchaseCompletion = await completePurchaseOperation(
                row as ResubmitRow,
                op as Record<string, unknown>
              );
            }
          } catch (completionError: unknown) {
            const message =
              completionError instanceof Error
                ? completionError.message
                : String(completionError);
            const permanent =
              completionError instanceof PermanentPurchaseOperationError;
            await mirrorPurchaseOperationFailure(
              row as ResubmitRow,
              message,
              permanent
            );
            if (permanent) {
              await failPipelineRow(row.id, message);
            } else {
              await failOrRetryPipelineRow(
                row.id,
                message,
                row.retry_count ?? 0
              );
            }
            logger.warn(
              `${LOG_PREFIX} ⚠️ ${row.step} ${row.id} completed at the bridge but could not be reconciled: ${message}`
            );
            continue;
          }
        }
        const msgs = op.result?.QBXML?.QBXMLMsgsRs || op.result?.QBXMLMsgsRs;
        const paymentBill =
          row.step === "vendor_bill_payment_check"
            ? extractVendorBillQueryRet(msgs, row.qb_txn_id)
            : null;
        const modifiedBill =
          row.step === "vendor_bill_mod"
            ? msgs?.BillModRs?.BillRet ?? null
            : null;
        if (row.step === "vendor_bill_payment_check" && !paymentBill) {
          // Two different facts hide behind "no BillRet":
          //   • QB answered statusCode 500 — the document is GONE. Permanent:
          //     retrying it hourly is what produced the row-per-hour leak.
          //   • anything else — we could not tell. Keep the ordinary retry path.
          if (isQbObjectNotFound(msgs?.BillQueryRs)) {
            const qbMessage =
              qbStatusMessage(msgs?.BillQueryRs) ??
              "QuickBooks reported the Bill as not found";
            const { billMarked } = await settleBillMissingInQb(
              row.id,
              row.reference_id ?? null,
              `Bill no longer exists in QuickBooks — payment checks stopped. QB said: ${qbMessage}`
            );
            logger.warn(
              `${LOG_PREFIX} 🚫 vendor_bill_payment_check ${row.id}: QuickBooks no longer has Bill ${row.qb_txn_id} (vendor_bill ${row.reference_id ?? "?"}) — row skipped${billMarked ? ", bill flagged as missing" : ""}`
            );
            continue;
          }
          await failOrRetryPipelineRow(
            row.id,
            "BillQuery completed without a matching QuickBooks Bill",
            row.retry_count
          );
          continue;
        }
        if (row.step === "vendor_bill_mod" && !modifiedBill) {
          const statusMessage =
            msgs?.BillModRs?.statusMessage ??
            msgs?.BillModRs?.["@statusMessage"] ??
            "BillMod completed without BillRet";
          await pool.query(
            `UPDATE qb_vendor_bill_pipeline
                SET status = 'error', qb_operation_id = NULL,
                    last_error = $2, updated_at = NOW()
              WHERE vendor_bill_id = $1 AND intent = 'mod' AND deleted_at IS NULL`,
            [row.reference_id, String(statusMessage)]
          );
          await failOrRetryPipelineRow(
            row.id,
            String(statusMessage),
            row.retry_count
          );
          continue;
        }
        const txnId =
          purchaseCompletion?.txnId ||
          op.txnId ||
          op.result?.TxnID ||
          op.listId ||
          op.result?.ListID ||
          msgs?.CheckAddRs?.CheckRet?.TxnID ||
          msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.TxnID ||
          msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.TxnID ||
          msgs?.CreditMemoAddRs?.CreditMemoRet?.TxnID ||
          msgs?.InventoryAdjustmentAddRs?.InventoryAdjustmentRet?.TxnID ||
          msgs?.InventoryAdjustmentModRs?.InventoryAdjustmentRet?.TxnID ||
          modifiedBill?.TxnID ||
          null;
        const refNumber =
          purchaseCompletion?.refNumber ||
          op.refNumber ||
          op.result?.RefNumber ||
          msgs?.CheckAddRs?.CheckRet?.RefNumber ||
          msgs?.ReceivePaymentAddRs?.ReceivePaymentRet?.RefNumber ||
          msgs?.ReceivePaymentModRs?.ReceivePaymentRet?.RefNumber ||
          msgs?.CreditMemoAddRs?.CreditMemoRet?.RefNumber ||
          msgs?.InventoryAdjustmentAddRs?.InventoryAdjustmentRet?.RefNumber ||
          msgs?.InventoryAdjustmentModRs?.InventoryAdjustmentRet?.RefNumber ||
          modifiedBill?.RefNumber ||
          null;

        if (
          row.step === "vendor_bill_payment_check" &&
          row.reference_id &&
          paymentBill
        ) {
          const amountDue = Number(paymentBill.AmountDue);
          const balanceCents = Number.isFinite(amountDue)
            ? Math.round(amountDue * 100)
            : null;
          await pool.query(
            `UPDATE vendor_bill
                SET qb_is_paid = $2,
                    qb_balance_remaining_cents = $3,
                    qb_payment_checked_at = NOW(),
                    qb_edit_sequence = COALESCE($4, qb_edit_sequence),
                    updated_at = NOW()
              WHERE id = $1 AND deleted_at IS NULL`,
            [
              row.reference_id,
              vendorBillIsPaid(paymentBill),
              balanceCents,
              paymentBill.EditSequence
                ? String(paymentBill.EditSequence)
                : null,
            ]
          );
          logger.info(
            `${LOG_PREFIX} ✅ Vendor Bill ${row.reference_id} payment status refreshed from QuickBooks`
          );
        }

        if (row.step === "vendor_bill_mod" && row.reference_id && modifiedBill) {
          const editSequence = modifiedBill.EditSequence
            ? String(modifiedBill.EditSequence)
            : null;
          if (!editSequence) {
            await failOrRetryPipelineRow(
              row.id,
              "BillMod completed without EditSequence",
              row.retry_count
            );
            continue;
          }
          const amountDue = Number(modifiedBill.AmountDue);
          const balanceCents = Number.isFinite(amountDue)
            ? Math.round(amountDue * 100)
            : null;
          const paidState =
            modifiedBill.IsPaid !== undefined || balanceCents !== null
              ? vendorBillIsPaid(modifiedBill)
              : null;
          await pool.query(
            `UPDATE qb_vendor_bill_pipeline
                  SET status = 'synced', qb_operation_id = NULL,
                      qb_txn_id = COALESCE($2, qb_txn_id),
                      qb_ref_number = COALESCE($3, qb_ref_number),
                      edit_sequence = $4, synced_at = NOW(), retries = 0,
                      last_error = NULL, next_retry_at = NULL, updated_at = NOW()
                WHERE vendor_bill_id = $1 AND intent = 'mod' AND deleted_at IS NULL`,
            [row.reference_id, txnId, refNumber, editSequence]
          );
          await pool.query(
            `UPDATE vendor_bill
                  SET status = 'synced', qb_source = 'owned',
                      qb_txn_id = COALESCE($2, qb_txn_id),
                      qb_ref_number = COALESCE($3, qb_ref_number),
                      qb_edit_sequence = $4, qb_synced_at = NOW(),
                      qb_is_paid = COALESCE($5, qb_is_paid),
                      qb_balance_remaining_cents =
                        COALESCE($6, qb_balance_remaining_cents),
                      qb_payment_checked_at = CASE
                        WHEN $5::boolean IS NOT NULL OR $6::bigint IS NOT NULL
                          THEN NOW()
                        ELSE qb_payment_checked_at
                      END,
                      updated_at = NOW()
                WHERE id = $1 AND deleted_at IS NULL`,
            [
              row.reference_id,
              txnId,
              refNumber,
              editSequence,
              paidState,
              balanceCents,
            ]
          );
          logger.info(
            `${LOG_PREFIX} ✅ Vendor Bill ${row.reference_id} modified in QuickBooks`
          );
        }

        const wonConfirm = await confirmPipelineRow(
          row.id,
          txnId,
          refNumber,
          op.result ?? null
        );
        // CAS: if another poller (consolidator Phase A vs the standalone
        // submitted-poller) already confirmed this row, skip ALL dependent
        // side-effects below (wake-dependents, metadata writes) so they never
        // run twice. The payment refresh above is intentionally idempotent and
        // happens first, so a transient pipeline-confirm failure cannot lose a
        // successfully queried QuickBooks balance.
        if (!wonConfirm) {
          continue;
        }

        if (row.step === "item_receipt_add" && row.reference_id) {
          try {
            const knex = container.resolve("__pg_connection__") as KnexRaw;
            const reconciliation = await reconcileReceiptModIfDrifted(
              knex,
              row.reference_id
            );
            if (reconciliation.enqueued) {
              logger.info(
                `${LOG_PREFIX} 🔁 Receipt ${row.reference_id} changed while its Add was in flight; corrective ItemReceiptMod queued behind the confirmed Add (${reconciliation.driftedSkus.join(", ")})`
              );
            } else if (reconciliation.driftedSkus.length > 0) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Receipt ${row.reference_id} drifted after Add but corrective Mod was not queued: ${reconciliation.reason}`
              );
            }
          } catch (reconcileError: unknown) {
            const message =
              reconcileError instanceof Error
                ? reconcileError.message
                : String(reconcileError);
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not reconcile receipt ${row.reference_id} after Add confirmation: ${message}`
            );
          }
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

        // Raw credit-memo line array (NOT the productId→ids map above): the
        // Subtotal / Discount lines are addressed by ItemRef.FullName, so they
        // never appear in a map keyed by ListID. Used below to persist their
        // TxnLineIDs so the next Mod can update them instead of recreating
        // them — see credit-memo-synthetic-lines.ts.
        const creditMemoLineRet =
          msgs?.CreditMemoAddRs?.CreditMemoRet?.CreditMemoLineRet ??
          msgs?.CreditMemoModRs?.CreditMemoRet?.CreditMemoLineRet ??
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

        // VOID-BEFORE-CREATE RACE GUARD — para TODOS los tipos de documento.
        //
        // Vivía inline dentro del bloque de invoice/SR de más abajo, así que
        // cubría un solo tipo y un solo camino. La POS Invoice 21246 confirmó
        // por el camino INLINE de handle-fulfillment-created, nunca pasó por
        // acá, y quedó huérfana y abierta en QB con $18.917,94 de balance.
        //
        // Ahora la lógica es compartida (pipeline/void-intent.ts) y la llaman
        // TODOS los caminos que confirman un ADD — este y los seis inline.
        // Corre para cualquier step de create, no sólo invoice/SR.
        await enqueueVoidIfAlreadyVoided({
          createStep: row.step,
          referenceId: row.reference_id,
          orderId: row.order_id ?? null,
          qbTxnId: txnId,
          qbRefNumber: refNumber ?? null,
          medusaRefNumber: refNumber ?? row.reference_id,
          logger,
        });

        // ── Ajuste de defectuosos de un credit memo ────────────────────────
        // Acá es donde el credit memo se entera de que su ajuste existe. Sin
        // este stamp el TxnID nunca se persiste y el siguiente cambio de
        // defectuosos crearía un SEGUNDO ajuste en QuickBooks en vez de editar
        // el primero — que es exactamente lo contrario del modelo.
        if (
          (row.step === "cm_damage_adjustment" ||
            row.step === "cm_damage_adjustment_mod") &&
          row.reference_id &&
          txnId
        ) {
          try {
            const adjRet =
              msgs?.InventoryAdjustmentAddRs?.InventoryAdjustmentRet ??
              msgs?.InventoryAdjustmentModRs?.InventoryAdjustmentRet;
            const editSequence = adjRet?.EditSequence ?? null;

            // Las tres van JUNTAS: un TxnID sin EditSequence no sirve para
            // ningún Mod posterior, y el ref es lo que hace rastreable el
            // documento desde QuickBooks sin consultarnos.
            await pool.query(
              `UPDATE pos_credit_memo
                  SET qb_inventory_adjustment_txn_id = $2,
                      qb_inventory_adjustment_ref = COALESCE($3, qb_inventory_adjustment_ref),
                      qb_inventory_adjustment_edit_sequence = $4
                WHERE id = $1`,
              [row.reference_id, txnId, refNumber, editSequence]
            );

            // Identidad de cada línea DENTRO del ajuste, para que el próximo
            // Mod pueda direccionarlas. Se mapea por ListID del ítem, que es
            // como QuickBooks las devuelve; el SKU no viaja en el Ret.
            const lineRets = adjRet?.InventoryAdjustmentLineRet;
            const lines = Array.isArray(lineRets)
              ? lineRets
              : lineRets
                ? [lineRets]
                : [];
            for (const line of lines) {
              const listId = line?.ItemRef?.ListID;
              const lineId = line?.TxnLineID;
              if (!listId || !lineId) continue;
              await pool.query(
                `UPDATE pos_credit_memo_item cmi
                    SET qb_adjustment_txn_line_id = $3
                  FROM product_variant pv
                 WHERE cmi.credit_memo_id = $1
                   AND cmi.variant_id = pv.id
                   AND pv.metadata->>'quickbooks_id' = $2
                   AND cmi.deleted_at IS NULL`,
                [row.reference_id, listId, lineId]
              );
            }

            logger.info(
              `${LOG_PREFIX} ✅ credit memo ${row.reference_id}: ajuste de defectuosos ${refNumber ?? ""} (TxnID=${txnId}, ${lines.length} línea/s) persistido`
            );
          } catch (dmgErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ No se pudo persistir el ajuste de defectuosos del credit memo ${row.reference_id}: ${dmgErr.message}`
            );
          }
        }

        // El void del ajuste confirmado suelta el puntero. Si no se limpia, el
        // próximo defectuoso intentaría un Mod sobre un documento voideado.
        if (row.step === "void_cm_damage_adjustment" && row.reference_id) {
          try {
            // Sólo se limpia si el puntero SIGUE apuntando al documento que se
            // acaba de voidear. Sin esa condición, un credit memo que ya creó su
            // ajuste de reemplazo —los defectuosos volvieron mientras el void
            // viajaba— perdía el puntero del ajuste NUEVO cuando confirmaba el
            // void del viejo, y quedaba con un documento vivo en QuickBooks que
            // nadie volvía a encontrar.
            const { rowCount: cleared } = await pool.query(
              `UPDATE pos_credit_memo
                  SET qb_inventory_adjustment_txn_id = NULL,
                      qb_inventory_adjustment_edit_sequence = NULL
                WHERE id = $1
                  AND qb_inventory_adjustment_txn_id = $2`,
              [row.reference_id, row.qb_txn_id]
            );
            if (!cleared) {
              // El puntero ya migró a un ajuste nuevo. Los TxnLineID de las
              // líneas pertenecen a ESE documento, así que tampoco se tocan:
              // borrarlos obligaría al próximo Mod a tratarlas como nuevas y
              // duplicaría las líneas del ajuste vivo.
              logger.info(
                `${LOG_PREFIX} credit memo ${row.reference_id}: el void de ${row.qb_txn_id} confirmó, pero el puntero ya apunta a otro ajuste — no se toca`
              );
            } else {
              await pool.query(
                `UPDATE pos_credit_memo_item
                    SET qb_adjustment_txn_line_id = NULL
                  WHERE credit_memo_id = $1 AND deleted_at IS NULL`,
                [row.reference_id]
              );
              logger.info(
                `${LOG_PREFIX} ✅ credit memo ${row.reference_id}: ajuste de defectuosos voideado, puntero liberado`
              );
            }
          } catch (dmgErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ No se pudo liberar el puntero del ajuste del credit memo ${row.reference_id}: ${dmgErr.message}`
            );
          }
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
              // Clears a stale 'voided' as well as a stale 'error'. An order
              // whose child document just synced is demonstrably alive, so a
              // leftover terminal flag is wrong by observation. This is what
              // self-heals the S11179 case: invoice voided, order stamped
              // terminal, then correctly re-invoiced — the re-invoice now
              // clears the flag instead of leaving the order invisible.
              //
              // Guarded on status: a canceled order can legitimately carry
              // 'voided', and nothing should resurrect it.
              await pool.query(
                `UPDATE "order"
                                 SET metadata = metadata || '{"qb_sync_status":"child_synced"}'::jsonb
                                 WHERE id = $1
                                   AND metadata->>'qb_sync_status' IN ('error', 'voided')
                                   AND status <> 'canceled'`,
                [row.order_id]
              );
            } catch (ordErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not clear stale qb_sync_status on order ${row.order_id}: ${ordErr.message}`
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
          // The ORDER is deliberately NOT stamped 'voided' here.
          //
          // void_invoice and void_sales_receipt are voids of a CHILD document.
          // Voiding an invoice returns its order to pre-invoiced — it does not
          // annul the order — and order.metadata.qb_sync_status='voided' is a
          // TERMINAL order state, written by handle-order-canceled and the two
          // close/cancel flows in api/admin/pos/sync. Nothing ever cleared it,
          // so a child void made the order terminal forever.
          //
          // S11179 is what that cost: invoiced in full by mistake, the invoice
          // voided, then correctly re-invoiced in part 2 hours later — and the
          // order kept the flag. The orders list drops is_voided from every tab
          // unless "Show Cancelled" is on, so an open order holding $16,776.23
          // of live deposit and $2,141.71 invoiced was invisible. 29 orders
          // carry the flag; 27 are genuinely canceled or closed, and that one
          // was the only live casualty.
          //
          // An order-level void has its own steps (void_sales_order,
          // void_estimate) and its own handlers. Those stay untouched.
        }

        // Revert-refund: the $0 apply ReceivePayment was deleted in QB — the
        // credit is free again. NOW run the Medusa revert (restores the
        // customer's credit) and wake the dependent void_check row. The
        // revert is claim-guarded, so a manual confirm-qb-cleanup that raced
        // ahead makes this a harmless no-op.
        if (row.step === "refund_apply_del" && row.reference_id) {
          try {
            const out = await performMedusaRefundRevert(row.reference_id, {
              actorId: null,
              reason: null, // staged at revert time (metadata.revert_reason)
              source: "qb_cleanup_confirmed",
            });
            if (out.ok) {
              logger.info(
                `${LOG_PREFIX} ✅ refund_apply_del confirmed → customer_payment ${row.reference_id} reverted to '${out.newStatus}' ($${((out.restoredCents ?? 0) / 100).toFixed(2)} restored as credit)`
              );
            } else if (out.code !== "ALREADY_REVERTED") {
              logger.warn(
                `${LOG_PREFIX} ⚠️ refund_apply_del confirmed but Medusa revert returned ${out.code} for ${row.reference_id}`
              );
            }
          } catch (revErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ refund_apply_del confirmed but Medusa revert failed for ${row.reference_id}: ${revErr.message}`
            );
          }
          try {
            await pool.query(
              `UPDATE qb_order_pipeline
                  SET status = 'pending', updated_at = NOW()
                WHERE depends_on = $1 AND step = 'void_check' AND status = 'waiting'`,
              [row.id]
            );
          } catch (wakeErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not wake dependent void_check for refund_apply_del ${row.id}: ${wakeErr.message}`
            );
          }
        }

        // Section 1.5.14: void_check confirmed → mark customer_payment qb.status='voided'.
        if (row.step === "void_check" && row.reference_id) {
          // Revert-refund completion (no-$0-doc chain): when the refund's
          // credit application lives directly on the check (zero-amount
          // apply created no ReceivePayment doc), the check void IS the
          // moment QB frees the credit → finish the pending Medusa revert.
          // Claim-guarded: if refund_apply_del already reverted, this no-ops.
          try {
            const { rows: cpStateRows } = await pool.query(
              `SELECT metadata->>'revert_state' AS revert_state
                 FROM customer_payment WHERE id = $1`,
              [row.reference_id]
            );
            if (cpStateRows[0]?.revert_state === "pending_qb_cleanup") {
              const out = await performMedusaRefundRevert(row.reference_id, {
                actorId: null,
                reason: null,
                source: "qb_cleanup_confirmed",
              });
              if (out.ok) {
                logger.info(
                  `${LOG_PREFIX} ✅ void_check confirmed → customer_payment ${row.reference_id} reverted to '${out.newStatus}' ($${((out.restoredCents ?? 0) / 100).toFixed(2)} restored as credit)`
                );
              } else if (out.code !== "ALREADY_REVERTED") {
                logger.warn(
                  `${LOG_PREFIX} ⚠️ void_check confirmed but Medusa revert returned ${out.code} for ${row.reference_id}`
                );
              }
            }
          } catch (revErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ void_check revert-completion failed for ${row.reference_id}: ${revErr.message}`
            );
          }
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

        // void_payment confirmado → el ReceivePayment ya no existe en QB.
        // Se estampa el resultado en el pago para que la UI y cualquier lector
        // posterior sepan que el borrado SÍ salió — sin esta marca, el
        // reconciliador y el propio void-intent lo verían como pendiente para
        // siempre y lo re-encolarían en cada confirm.
        if (row.step === "void_payment" && row.reference_id) {
          try {
            await pool.query(
              `UPDATE customer_payment
                  SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                      qb = COALESCE(qb, '{}'::jsonb) || '{"status":"voided"}'::jsonb
                WHERE id = $1`,
              [
                row.reference_id,
                JSON.stringify({
                  qb_sync_status: "voided",
                  qb_void_operation_id: row.bridge_op_id,
                }),
              ]
            );
            logger.info(
              `${LOG_PREFIX} ✅ void_payment confirmado → customer_payment ${row.reference_id} borrado en QB (op ${row.bridge_op_id})`
            );
          } catch (vpErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not stamp void_payment result on ${row.reference_id}: ${vpErr.message}`
            );
          }
        }

        // Drop any healed line order once a MOD lands. `qbLineOrder` is a
        // snapshot of how QB held the lines BEFORE this MOD; the MOD itself may
        // have appended, removed or re-created lines (subtotal/discount are
        // re-created every time), so keeping it would steer the NEXT MOD with a
        // stale map. Clearing is safe: the builder falls back to ascending
        // TxnLineID, and if that is wrong the 3290 heal re-reads the fresh
        // order from QB.
        if (String(row.step).endsWith("_mod")) {
          try {
            await pool.query(
              `UPDATE qb_order_pipeline
                  SET payload = payload - 'qbLineOrder'
                WHERE id = $1 AND payload ? 'qbLineOrder'`,
              [row.id]
            );
          } catch (lineOrderErr: any) {
            logger.warn(
              `${LOG_PREFIX} ⚠️ Could not clear qbLineOrder on row ${row.id}: ${lineOrderErr.message}`
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

          // Same idea for the two SYNTHETIC lines (QB "Subtotal" / "Discount"),
          // which have no pos_credit_memo_item row to hang a TxnLineID on and
          // were therefore deleted + recreated by QB on every single Mod. They
          // go on the credit memo's metadata instead.
          //
          // QB is the authority here, including when it says "gone": a Mod that
          // dropped the discount stores nulls, so the map can never outlive the
          // document and hand a stale TxnLineID to the next Mod. Only skipped
          // when QB returned no line array at all (nothing was learned).
          if (creditMemoLineRet) {
            try {
              const syntheticLineIds =
                extractQbSyntheticLineIds(creditMemoLineRet);
              await pool.query(
                `UPDATE pos_credit_memo
                    SET metadata = jsonb_set(
                                     COALESCE(metadata, '{}'::jsonb),
                                     $2::text[],
                                     $3::jsonb,
                                     true
                                   )
                  WHERE id = $1`,
                [
                  row.reference_id,
                  `{${CM_SYNTHETIC_LINE_IDS_META_KEY}}`,
                  JSON.stringify(syntheticLineIds),
                ]
              );
              logger.info(
                `${LOG_PREFIX} ✅ Persisted synthetic line ids for CM ${row.reference_id} (subtotal=${syntheticLineIds.subtotal ?? "none"}, discount=${syntheticLineIds.discount ?? "none"})`
              );
            } catch (synthErr: any) {
              logger.warn(
                `${LOG_PREFIX} ⚠️ Could not persist synthetic line ids for CM ${row.reference_id}: ${synthErr.message}`
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
                                 SET metadata = COALESCE(metadata, '{}') || $2::jsonb,
                                     qb = COALESCE(qb, '{}') || $3::jsonb,
                                     updated_at = NOW()
                                 WHERE reference = $1
                                   AND type = 'credit_memo'
                                   AND status <> 'voided'
                                   AND deleted_at IS NULL
                                   AND (metadata->>'qb_txn_id') IS DISTINCT FROM $4`,
                [
                  cmNumber,
                  JSON.stringify({
                    qb_txn_id: txnId,
                    qb_sync_status: "synced",
                  }),
                  JSON.stringify({ status: "yes", txn_id: txnId }),
                  txnId,
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

          // Activate waiting refund_payment rows (ALL refund types).
          // Shared logic in activateRefundPaymentRow — if the bridge call
          // throws here, the row stays 'waiting' and runRefundPaymentRecovery
          // re-claims it on the next consolidator tick.
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
                  await activateRefundPaymentRow(pool, logger, rpRow, txnId);
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
                               AND step IN ('void_sales_order', 'void_invoice', 'estimate_deactivate')`,
              [row.id]
            );
            for (const voidRow of waitingVoids) {
              try {
                const vResult =
                  voidRow.step === "void_invoice"
                    ? await voidInvoiceInQb(txnId, (m) => logger.info(m))
                    : voidRow.step === "estimate_deactivate"
                      ? await deactivateEstimateInQb(
                          txnId,
                          undefined,
                          (m) => logger.info(m)
                        )
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

        if (
          txnId &&
          row.order_id &&
          row.step !== "transfer_customer" &&
          row.step !== "vendor_bill_mod" &&
          !isPurchaseOperationStep(row.step)
        ) {
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
        if (
          row.step === "vendor_bill_rebuild_delete" &&
          isAlreadyMissingBillDeleteError(errMsg)
        ) {
          try {
            await completeVendorBillRebuildDelete(row as ResubmitRow);
            await confirmPipelineRow(row.id, null, null, {
              already_missing: true,
              bridge_error: errMsg,
            });
            logger.warn(
              `${LOG_PREFIX} ♻️ ${row.step} ${row.id} returned 3120; treated as success because the QB Bill is already absent`
            );
          } catch (completionError: unknown) {
            const message =
              completionError instanceof Error
                ? completionError.message
                : String(completionError);
            await mirrorPurchaseOperationFailure(
              row as ResubmitRow,
              message
            );
            await failOrRetryPipelineRow(
              row.id,
              message,
              row.retry_count ?? 0
            );
          }
          continue;
        }
        // ── ADD con resultado desconocido ────────────────────────────────────
        // Un HRESULT de nivel QBWC llega con la respuesta VACÍA: la sesión se
        // abortó y QuickBooks nunca dijo qué hizo. Fallar acá deja la fila
        // dormida mientras el documento puede estar creado — y el Retry humano
        // siguiente, sin verificar, lo duplicaría.
        //
        // Pasó el 2026-08-05 con VB-1082 / PO-1111: `0x8004041C` DESPUÉS de que
        // QuickBooks ya había guardado el Bill (TxnID 1CC54C-1785955489). La
        // fila quedó `failed` con `next_retry_at = NULL` y la cadena entera de
        // ese PO bloqueada detrás.
        //
        // La consulta de existencia es READ-ONLY: si el documento no está,
        // `markPurchaseAddVerifiedAbsent` despeja el camino y el ADD sale igual.
        // O sea que el peor caso de verificar es una query de más.
        if (
          (row.step === "item_receipt_add" || row.step === "vendor_bill_add") &&
          classifyQbError({ message: errMsg }).class === "outcome_unknown"
        ) {
          const scheduled = await schedulePurchaseAddExistenceCheck(
            row as ResubmitRow,
            `QuickBooks abortó la sesión sin responder (${errMsg.slice(0, 120)}); se verifica existencia antes de reintentar`
          );
          if (scheduled) {
            logger.warn(
              `${LOG_PREFIX} 🔎 ${row.step} ${row.id} falló a nivel QBWC; el resultado en QB es desconocido → existence check read-only antes de cualquier ADD`
            );
            continue;
          }
          logger.error(
            `${LOG_PREFIX} 🛑 ${row.step} ${row.id}: existence check exhausted tras un error de sesión; se marca fallida para revisión manual`
          );
        }

        const decision = await failOrRetryPipelineRow(
          row.id,
          errMsg,
          row.retry_count ?? 0
        );
        if (isPurchaseOperationStep(row.step)) {
          await mirrorPurchaseOperationFailure(
            row as ResubmitRow,
            errMsg
          );
        }
        if (row.step === "vendor_bill_mod" && row.reference_id) {
          await pool.query(
            `UPDATE qb_vendor_bill_pipeline
                SET status = 'error', qb_operation_id = NULL,
                    last_error = $2, updated_at = NOW()
              WHERE vendor_bill_id = $1 AND intent = 'mod' AND deleted_at IS NULL`,
            [row.reference_id, errMsg]
          );
        }
        // Invalidate cached EditSequence — but only when the error implies
        // the cached value is wrong. Error 3175 ("transaction locked") means
        // QB never touched the document, so the cache is still valid.
        const isLockedError =
          errMsg.includes("3175") || errMsg.includes("could not be locked");
        if (row.qb_txn_id && !isLockedError) {
          await invalidateEditSequenceCache(
            stepToCacheEntityType(
              row.step as string,
              (row.reference_type as string | null) ?? null
            ),
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
            row.id as string,
            (row.reference_type as string | null) ?? null
          ).catch((healErr: unknown) => {
            const msg =
              healErr instanceof Error ? healErr.message : String(healErr);
            logger.warn(
              `${LOG_PREFIX} ⚠️ Auto-heal threw for row ${row.id}: ${msg}`
            );
          });
        }

        // Auto-heal: QB error 3290 means our line ORDER disagrees with the
        // document's. Unlike the EditSequence heal this one runs even when the
        // retry budget is spent — 3290 is deterministic, so an exhausted row is
        // exactly the row that needs it (the budget burned while it was
        // unfixable). healLineOrderForRow re-arms the row itself.
        if (
          row.qb_txn_id &&
          isLineOrderError(errMsg) &&
          canHealLineOrder(row.step as string)
        ) {
          await healLineOrderForRow(
            row.step as string,
            row.qb_txn_id as string,
            logger,
            row.id as string
          ).catch((healErr: unknown) => {
            const msg =
              healErr instanceof Error ? healErr.message : String(healErr);
            logger.warn(
              `${LOG_PREFIX} ⚠️ Line-order heal threw for row ${row.id}: ${msg}`
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
                               AND step IN ('void_sales_order', 'void_invoice', 'estimate_deactivate')`,
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
      const message =
        pollErr instanceof Error ? pollErr.message : String(pollErr);
      if (
        isPurchaseOperationStep(row.step) &&
        /\b404\b|expired|no longer in bridge/i.test(message)
      ) {
        if (
          row.step === "item_receipt_add" ||
          row.step === "vendor_bill_add"
        ) {
          const scheduled = await schedulePurchaseAddExistenceCheck(
            row as ResubmitRow,
            `Lost bridge operation ${row.bridge_op_id}; verifying QuickBooks before retry`
          );
          if (scheduled) {
            logger.warn(
              `${LOG_PREFIX} 🔎 Lost ${row.step} operation ${row.bridge_op_id}; scheduled read-only existence check before any retry`
            );
            continue;
          }
          // Tope agotado: NO se cae al ADD a ciegas. Falla visible para un
          // humano, que es lo único correcto cuando ni siquiera se pudo
          // preguntarle a QuickBooks qué pasó.
          logger.error(
            `${LOG_PREFIX} 🛑 ${row.step} ${row.id}: existence check exhausted; failing for manual review instead of re-adding`
          );
        }
        const decision = await failOrRetryPipelineRow(
          row.id,
          message,
          row.retry_count ?? 0
        );
        await mirrorPurchaseOperationFailure(
          row as ResubmitRow,
          message
        );
        logger.warn(
          `${LOG_PREFIX} ⚠️ Lost ${row.step} operation ${row.bridge_op_id}; MOD is safe to retry (${decision.newStatus})`
        );
        continue;
      }
      logger.warn(
        `${LOG_PREFIX} ⚠️ Error polling row ${row.id} op ${row.bridge_op_id}: ${message}`
      );
    }
  }
}
