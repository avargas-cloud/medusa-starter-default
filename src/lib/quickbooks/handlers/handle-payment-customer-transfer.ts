import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getDbPool } from "../../../api/utils/db-pool";
import {
  bridgeFetch,
  pollOperationResult,
  pollRawOperationResult,
} from "../client/core";
import { receivePaymentInQb } from "../client/payments";
import { ensureCustomerInQb } from "../order-flow-core";
import { confirmPipelineRow, failOrRetryPipelineRow } from "../qb-pipeline";

const LOG_PREFIX = "[QB-PAYMENT-TRANSFER]";

interface TransferPayload {
  target_customer_id?: string;
  transfer_id?: string; // customer_payment_transfer.id (audit row)
  payment_id?: string;
  // sub-state persisted across retries for idempotency
  recreate?: {
    amount_dollars: number;
    paymentMethod?: string;
    memo?: string;
    refNumber?: string;
  };
  delete_operation_id?: string;
  old_deleted?: boolean;
  create_operation_id?: string;
  new_txn_id?: string;
}

function isNotFoundError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("3120") ||
    m.includes("could not be found") ||
    m.includes("not found") ||
    m.includes("no matching")
  );
}

/** Op result no longer obtainable (bridge GC'd it or polling gave up). */
function isExpiredPollError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("expired") || m.includes("timed out") || m.includes("timeout");
}

async function savePayload(rowId: string, payload: TransferPayload) {
  await getDbPool().query(
    `UPDATE qb_order_pipeline SET payload = $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [rowId, JSON.stringify(payload)]
  );
}

/**
 * transfer_payment pipeline step — moves a SYNCED, UNAPPLIED ReceivePayment from
 * the old customer to the new one in QB by DELETE (TxnDel via /void) + RECREATE
 * under the new customer's ListID (QB cannot mutate a ReceivePayment's customer).
 *
 * Idempotent across crashes/timeouts/retries via payload sub-state. Each QB
 * mutation persists its operationId BEFORE polling, so a retry RE-POLLS the same
 * op instead of re-issuing it — never a duplicate delete or (critically) a
 * duplicate ReceivePayment. Flags advance only after QB confirms:
 *   recreate{}            captured once from the live txn (re-checked unapplied each run pre-delete)
 *   delete_operation_id   set before polling the delete; not-found ⇒ already deleted
 *   old_deleted           true once the delete is confirmed
 *   create_operation_id   set before polling the create; re-polled on retry (no 2nd create)
 *   new_txn_id            set once the recreate is confirmed
 */
export async function handlePaymentCustomerTransfer(
  row: { id: string; reference_id: string | null },
  container: MedusaContainer,
  logger: any
): Promise<void> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT payload, retry_count FROM qb_order_pipeline WHERE id = $1`,
    [row.id]
  );
  const payload = (rows[0]?.payload ?? {}) as TransferPayload;
  const retriesSoFar = (rows[0]?.retry_count as number) ?? 0;

  const targetCustomerId = payload.target_customer_id;
  const paymentRowId = payload.payment_id;
  const log = (m: string) => logger.info(`${LOG_PREFIX} ${m}`);

  // Best-effort failure marker — must NEVER throw (it is invoked via `return
  // fail(...)` inside the try, so a throw here would escape the local catch).
  const fail = async (msg: string) => {
    try {
      logger.error(`${LOG_PREFIX} ❌ ${msg}`);
      if (payload.transfer_id) {
        await pool
          .query(
            `UPDATE customer_payment_transfer SET qb_status='failed', updated_at=NOW() WHERE id=$1`,
            [payload.transfer_id]
          )
          .catch(() => {});
      }
      if (paymentRowId) {
        await pool
          .query(
            `UPDATE customer_payment
                SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{qb_sync_status}', '"error"'),
                    updated_at = NOW()
              WHERE id = $1`,
            [paymentRowId]
          )
          .catch(() => {});
      }
      const decision = await failOrRetryPipelineRow(row.id, msg, retriesSoFar);
      // Permanent failure (no retry scheduled) ⇒ cascade-fail the WHOLE chain of
      // transfers waiting (transitively) on this one, else a grandchild link waits
      // forever and its audit row stays 'pending'.
      if (decision.nextRetryAt === null) {
        await pool
          .query(
            `WITH RECURSIVE chain AS (
               SELECT id, payload->>'transfer_id' AS transfer_id
                 FROM qb_order_pipeline
                WHERE depends_on=$1 AND step='transfer_payment' AND status='waiting'
               UNION ALL
               SELECT p.id, p.payload->>'transfer_id'
                 FROM qb_order_pipeline p
                 JOIN chain c ON p.depends_on=c.id
                WHERE p.step='transfer_payment' AND p.status='waiting'
             ),
             fp AS (
               UPDATE qb_order_pipeline SET status='failed', failed_at=NOW(), updated_at=NOW(),
                      error='Prior transfer in chain failed — resolve it first'
                WHERE id IN (SELECT id FROM chain)
             )
             UPDATE customer_payment_transfer SET qb_status='failed', updated_at=NOW()
              WHERE id IN (SELECT transfer_id FROM chain WHERE transfer_id IS NOT NULL)`,
            [row.id]
          )
          .catch(() => {});
      }
    } catch (failErr: any) {
      logger.error(`${LOG_PREFIX} fail() itself errored: ${failErr?.message}`);
    }
  };

  if (!targetCustomerId || !paymentRowId) {
    return fail(
      `payload incomplete (target_customer_id=${!!targetCustomerId}, payment_id=${!!paymentRowId})`
    );
  }

  try {
    // 1. Ensure the target customer has a QB ListID.
    const customerModule = container.resolve(Modules.CUSTOMER) as any;
    const target = await customerModule.retrieveCustomer(targetCustomerId);
    let qbListId: string | undefined = target?.metadata?.qb_list_id as
      | string
      | undefined;
    if (!qbListId) {
      const ensured = await ensureCustomerInQb(target, customerModule, log);
      if (!ensured.success || !ensured.qbCustomerId) {
        return fail(
          `could not ensure QB customer for ${targetCustomerId}: ${ensured.error ?? "unknown"}`
        );
      }
      qbListId = ensured.qbCustomerId;
    }

    // 2. Until the old txn is deleted, query it LIVE and re-verify it is still
    //    unapplied in QB (TOCTOU: staff may apply/deposit it between retries).
    //    The current txn is resolved live from the payment so chained links
    //    operate on the txn the previous link created.
    if (!payload.old_deleted) {
      const { rows: payRows } = await pool.query(
        `SELECT metadata FROM customer_payment WHERE id = $1`,
        [paymentRowId]
      );
      const oldTxnId = payRows[0]?.metadata?.qb_txn_id as string | undefined;
      if (!oldTxnId) {
        return fail(`payment ${paymentRowId} has no current qb_txn_id`);
      }

      const queryRes = await bridgeFetch("GET", `/api/payments/${oldTxnId}`);
      const opId = queryRes?.operationId;
      if (!opId) throw new Error("Bridge did not queue the payment query");
      const raw = await pollRawOperationResult(opId, log);
      const rs =
        raw?.QBXML?.QBXMLMsgsRs?.ReceivePaymentQueryRs ??
        raw?.QBXMLMsgsRs?.ReceivePaymentQueryRs;
      const ret = rs?.ReceivePaymentRet;
      const retObj = Array.isArray(ret) ? ret[0] : ret;
      const confirmedNotFound = isNotFoundError(
        String(rs?.$?.statusMessage ?? "")
      );
      if (!retObj) {
        if (confirmedNotFound && payload.recreate) {
          // CONFIRMED gone in QB + recreate fields already captured ⇒ an earlier
          // (unpersisted) delete or an external delete removed it. Proceed.
          payload.old_deleted = true;
          await savePayload(row.id, payload);
          log(`old txn ${oldTxnId} confirmed gone — proceeding to recreate`);
        } else if (confirmedNotFound) {
          return fail(
            `QB has no ReceivePayment for TxnID=${oldTxnId} and no captured fields to recreate`
          );
        } else {
          // Empty result that is NOT a confirmed not-found ⇒ transient (race /
          // partial response). Retry rather than assume deleted — assuming deleted
          // here would skip a real delete and DUPLICATE the payment.
          throw new Error(
            `QB query for TxnID=${oldTxnId} returned no ReceivePaymentRet (status ${rs?.$?.statusCode}) — retrying`
          );
        }
      } else {
        // Applied-check only BEFORE a delete op is issued. Once the void is queued
        // the decision is committed; re-aborting here would leave the queued void
        // to run anyway. (QB itself refuses to delete an applied payment.)
        if (!payload.delete_operation_id) {
          const applied = retObj.AppliedToTxnRet;
          const appliedArr = applied
            ? Array.isArray(applied)
              ? applied
              : [applied]
            : [];
          if (appliedArr.length > 0) {
            return fail(
              `QB ReceivePayment ${oldTxnId} is APPLIED to ${appliedArr.length} txn(s) — unapply in QB Desktop before transferring`
            );
          }
        }
        if (!payload.recreate) {
          payload.recreate = {
            amount_dollars: parseFloat(String(retObj.TotalAmount ?? "0")),
            paymentMethod: retObj.PaymentMethodRef?.FullName,
            memo: retObj.Memo,
            refNumber: retObj.RefNumber,
          };
          await savePayload(row.id, payload);
          // Record the ACTUAL txn being moved on the audit row (accurate even for
          // coalesced/chained links that resolve the txn live at run time).
          if (payload.transfer_id) {
            await pool
              .query(
                `UPDATE customer_payment_transfer SET qb_old_txn_id=$2, updated_at=NOW() WHERE id=$1`,
                [payload.transfer_id, oldTxnId]
              )
              .catch(() => {});
          }
        }

        // 3. Delete the old ReceivePayment (TxnDel). Persist the op id BEFORE
        //    polling so a retry re-polls instead of re-issuing.
        let deleteOpId = payload.delete_operation_id;
        if (!deleteOpId) {
          const delRes = await bridgeFetch(
            "POST",
            `/api/payments/${oldTxnId}/void`
          );
          if (!delRes?.success || !delRes?.operationId) {
            throw new Error(delRes?.error ?? "Bridge did not queue the delete");
          }
          deleteOpId = delRes.operationId as string;
          payload.delete_operation_id = deleteOpId;
          await savePayload(row.id, payload);
        }
        try {
          await pollRawOperationResult(deleteOpId, log);
        } catch (delErr: any) {
          const m = String(delErr?.message ?? "");
          if (isNotFoundError(m)) {
            log(`delete reported not-found — already deleted`);
          } else if (isExpiredPollError(m)) {
            // Op result no longer obtainable and the txn is STILL live here ⇒ the
            // delete didn't take. Drop the op id so the next retry re-issues it
            // (TxnDel is idempotent: a real prior delete returns not-found).
            delete payload.delete_operation_id;
            await savePayload(row.id, payload);
            throw new Error(
              `delete op for ${oldTxnId} expired before confirmation — will re-issue on retry`
            );
          } else {
            throw delErr;
          }
        }
        payload.old_deleted = true;
        await savePayload(row.id, payload);
        log(`✅ QB confirmed delete of ${oldTxnId}`);
      }
    }

    // 4. Recreate under the new customer. Persist the create op id BEFORE polling
    //    so a retry re-polls the SAME op — never a duplicate ReceivePayment.
    if (!payload.new_txn_id) {
      if (!payload.recreate) {
        return fail("internal: recreate fields missing after delete");
      }
      let createOpId = payload.create_operation_id;
      if (!createOpId) {
        const createRes = await receivePaymentInQb({
          customerId: qbListId,
          amount: payload.recreate.amount_dollars,
          paymentMethod: payload.recreate.paymentMethod,
          memo: payload.recreate.memo,
          refNumber: payload.recreate.refNumber,
          autoApply: false,
        });
        if (!createRes.success || !createRes.data?.operationId) {
          throw new Error(createRes.error ?? "Bridge did not queue the recreate");
        }
        createOpId = createRes.data.operationId as string;
        payload.create_operation_id = createOpId;
        await savePayload(row.id, payload);
      }
      let created;
      try {
        created = await pollOperationResult(createOpId, log);
      } catch (createErr: any) {
        // The create op result is unknown (expired/timed out). DO NOT re-create
        // blindly — that risks a duplicate. Surface for operator verification.
        return fail(
          `recreate op ${payload.create_operation_id} result unknown (${createErr?.message}) — verify in QB before retry`
        );
      }
      if (!created.txnId) {
        // Poll returned without a TxnID (timeout). Same risk — surface, don't recreate.
        return fail(
          `recreate op ${payload.create_operation_id} did not return a TxnID yet — verify in QB before retry`
        );
      }
      payload.new_txn_id = created.txnId;
      await savePayload(row.id, payload);
      log(`✅ Recreated as TxnID=${payload.new_txn_id}`);
    }

    // 5. Repoint the payment at the new QB txn — ALWAYS (idempotent), even on a
    //    resumed run that already had new_txn_id, so the authoritative pointer is
    //    never left on the deleted txn.
    await pool.query(
      `UPDATE customer_payment
          SET metadata = jsonb_set(
                jsonb_set(COALESCE(metadata,'{}'::jsonb), '{qb_txn_id}', to_jsonb($2::text)),
                '{qb_sync_status}', '"synced"'),
              updated_at = NOW()
        WHERE id = $1`,
      [paymentRowId, payload.new_txn_id]
    );

    // 6. Audit + confirm.
    if (payload.transfer_id) {
      await pool.query(
        `UPDATE customer_payment_transfer
            SET qb_new_txn_id=$2, qb_status='completed', updated_at=NOW() WHERE id=$1`,
        [payload.transfer_id, payload.new_txn_id]
      );
    }
    await confirmPipelineRow(row.id, payload.new_txn_id ?? null, null, null);
    log(`🎉 transfer_payment ${row.id} complete (new txn ${payload.new_txn_id})`);
  } catch (err: any) {
    await fail(String(err?.message ?? err).slice(0, 300));
  }
}
