/**
 * Auto-heal for QB Error 3200 / "EditSequence is out-of-date".
 *
 * When a *_mod step fails because the cached/stored EditSequence is stale
 * (the QB doc was modified between our cache write and our mod attempt),
 * the only way forward is to fetch the CURRENT EditSequence from QB Desktop
 * and re-stage the row with the fresh value.
 *
 * This module performs that auto-fetch + DB update so the next consolidator
 * tick retries with a valid sequence. It is invoked from poll-submitted-rows
 * when an `op.status === "failed"` carries the `edit_seq` classification.
 */

import { getDbPool } from "../../../api/utils/db-pool";
import { bridgeFetch, pollRawOperationResult } from "../client/core";
import { cacheEditSequence } from "../qb-pipeline";

type PipelineStep = string;

/**
 * Fetches the current EditSequence from QB for the given (step, txnId) and
 * persists it to the owning row (e.g. `pos_credit_memo.qb_edit_sequence`)
 * AND the EditSequence cache. Returns the fresh sequence, or null if the
 * recovery flow could not complete (caller should log + let normal retry
 * backoff continue).
 *
 * Per-step ownership map. Extend when adding more *_mod steps:
 *   credit_memo_mod → pos_credit_memo.qb_edit_sequence
 */
export async function refreshEditSequenceForRow(
  step: PipelineStep,
  txnId: string,
  referenceId: string | null,
  logger: { info: (m: string) => void; warn: (m: string) => void },
  pipelineRowId?: string | null
): Promise<string | null> {
  const LOG_PREFIX = "[QB-AUTO-HEAL]";

  if (!txnId) {
    logger.warn(`${LOG_PREFIX} No txnId provided for step=${step} — abort`);
    return null;
  }

  const fetchSpec = STEP_FETCH_SPEC[step];
  if (!fetchSpec) {
    logger.warn(
      `${LOG_PREFIX} No auto-heal recipe for step=${step} — leaving stale EditSequence in place`
    );
    return null;
  }

  // 1. Ask QB for the fresh EditSequence.
  let freshEditSeq: string | null = null;
  try {
    const queryResp = await bridgeFetch("GET", `${fetchSpec.endpoint}/${txnId}`);
    const queryOpId = queryResp?.operationId;
    if (!queryOpId) {
      logger.warn(
        `${LOG_PREFIX} Bridge GET ${fetchSpec.endpoint}/${txnId} returned no operationId`
      );
      return null;
    }
    const rawResult = await pollRawOperationResult(queryOpId, (m: string) =>
      logger.info(`${LOG_PREFIX} ${m}`)
    );
    freshEditSeq = fetchSpec.extractEditSequence(rawResult);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `${LOG_PREFIX} Could not fetch fresh EditSequence for ${step} ${txnId}: ${msg}`
    );
    return null;
  }

  if (!freshEditSeq) {
    logger.warn(
      `${LOG_PREFIX} QB returned no EditSequence for ${step} ${txnId} — entity may have been deleted`
    );
    return null;
  }

  // 2. Persist on the owning row so the next mod attempt picks it up.
  if (referenceId && fetchSpec.persistColumn) {
    const pool = getDbPool();
    try {
      await pool.query(
        `UPDATE ${fetchSpec.persistTable}
            SET ${fetchSpec.persistColumn} = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [referenceId, freshEditSeq]
      );
      logger.info(
        `${LOG_PREFIX} ✅ Refreshed ${fetchSpec.persistTable}.${fetchSpec.persistColumn} for ${referenceId} → ${freshEditSeq}`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `${LOG_PREFIX} Could not update ${fetchSpec.persistTable} ${referenceId}: ${msg}`
      );
      // continue — cache update below still helps
    }
  }

  // 3. Update the EditSequence cache so callers that read via the cache layer
  //    (e.g. updateCreditMemoInQb's cache hit branch) also pick up the new value.
  try {
    await cacheEditSequence(fetchSpec.cacheEntityType, txnId, freshEditSeq);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${LOG_PREFIX} Could not cache new EditSequence: ${msg}`);
  }

  // 4. Skip the exponential backoff. failOrRetryPipelineRow ran first and
  //    parked the row at NOW + 10min (or whatever the backoff slot dictated),
  //    but the cause is fixed — there is no transient bridge condition to wait
  //    on. Reset next_retry_at to NOW so the next consolidator tick picks it
  //    up immediately instead of sitting idle for minutes.
  if (pipelineRowId) {
    const pool = getDbPool();
    try {
      await pool.query(
        `UPDATE qb_order_pipeline
            SET next_retry_at = NOW(),
                updated_at    = NOW()
          WHERE id = $1 AND status = 'failed'`,
        [pipelineRowId]
      );
      logger.info(
        `${LOG_PREFIX} ⚡ Rescheduled row ${pipelineRowId} for immediate retry`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`${LOG_PREFIX} Could not reschedule row: ${msg}`);
    }
  }

  return freshEditSeq;
}

interface FetchSpec {
  /** Bridge endpoint that returns a QBXML response with EditSequence on GET. */
  endpoint: string;
  /** Entity type used by the qb_edit_sequence_cache table. */
  cacheEntityType: string;
  /** Owning table whose row carries the cached EditSequence for retries. */
  persistTable: string;
  /** Column on `persistTable` that stores the EditSequence. */
  persistColumn: string;
  /**
   * Walks the bridge GET response to the EditSequence string. The bridge
   * wraps QBXML payloads in several known envelopes; this is the same
   * extraction shape voidCreditMemoInQb already uses.
   */
  extractEditSequence: (rawResult: unknown) => string | null;
}

function extractFromCreditMemoQuery(rawResult: unknown): string | null {
  const r = rawResult as Record<string, any> | null;
  const cmRet =
    r?.QBXML?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet ??
    r?.QBXMLMsgsRs?.CreditMemoQueryRs?.CreditMemoRet ??
    r?.CreditMemoRet;
  const editSeq = cmRet?.EditSequence;
  return typeof editSeq === "string" && editSeq.length > 0 ? editSeq : null;
}

const STEP_FETCH_SPEC: Record<string, FetchSpec> = {
  credit_memo_mod: {
    endpoint: "/api/credit-memos",
    cacheEntityType: "credit_memo",
    persistTable: "pos_credit_memo",
    persistColumn: "qb_edit_sequence",
    extractEditSequence: extractFromCreditMemoQuery,
  },
};

/**
 * Lightweight classifier for the failure path. The full classifyQbError
 * lives in error-classifier.ts and covers many classes; auto-heal cares
 * only about whether the error is the stale-EditSequence shape.
 */
export function isEditSequenceStaleError(message: string): boolean {
  if (!message) return false;
  // Matches QB Desktop's two phrasings + the bridge's normalized variants.
  return /edit\s*sequence|editsequence|\bout[\s-]?of[\s-]?date\b|\b3200\b|\b3210\b/i.test(
    message
  );
}
