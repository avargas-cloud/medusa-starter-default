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
 *   invoice_update / sales_order / estimate / sales_receipt_update → cache
 *     only (their client functions in ../client/*.ts already do a live
 *     re-fetch on failure or read the shared cache before every Mod — this
 *     is a backstop for the rare double-stale race, not the primary heal).
 *   transfer_customer → special-cased below: its EditSequence is frozen
 *     once into THIS pipeline row's own `payload.editSequence` at dispatch
 *     time (see handle-customer-transferred.ts) and every resubmit re-reads
 *     that same column (resubmit-by-step.ts), so a generic persistTable/
 *     persistColumn UPDATE can't reach it — it needs a jsonb_set on
 *     qb_order_pipeline itself, keyed by pipelineRowId.
 */
export async function refreshEditSequenceForRow(
  step: PipelineStep,
  txnId: string,
  referenceId: string | null,
  logger: { info: (m: string) => void; warn: (m: string) => void },
  pipelineRowId?: string | null,
  referenceType?: string | null
): Promise<string | null> {
  const LOG_PREFIX = "[QB-AUTO-HEAL]";

  if (!txnId) {
    logger.warn(`${LOG_PREFIX} No txnId provided for step=${step} — abort`);
    return null;
  }

  if (step === "transfer_customer") {
    return refreshTransferCustomerEditSequence(
      txnId,
      referenceType,
      logger,
      pipelineRowId ?? null
    );
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
  /** Owning table whose row carries the cached EditSequence for retries. Omit when the step has no such column (cache-only backstop). */
  persistTable?: string;
  /** Column on `persistTable` that stores the EditSequence. Omit alongside persistTable. */
  persistColumn?: string;
  /**
   * Walks the bridge GET response to the EditSequence string. The bridge
   * wraps QBXML payloads in several known envelopes; this is the same
   * extraction shape voidCreditMemoInQb already uses.
   */
  extractEditSequence: (rawResult: unknown) => string | null;
}

// Generic Query-response walker shared by every doc type below — the bridge
// wraps the same QBXML envelope shape for all of them, only the *Rs/*Ret key
// names differ.
function extractRet(rawResult: unknown, rsKey: string, retKey: string): string | null {
  const r = rawResult as Record<string, any> | null;
  const msgs = r?.QBXML?.QBXMLMsgsRs ?? r?.QBXMLMsgsRs ?? {};
  const ret = msgs?.[rsKey]?.[retKey] ?? r?.[retKey];
  const resolved = Array.isArray(ret) ? ret[0] : ret;
  const editSeq = resolved?.EditSequence;
  return typeof editSeq === "string" && editSeq.length > 0 ? editSeq : null;
}

const extractFromCreditMemoQuery = (r: unknown) =>
  extractRet(r, "CreditMemoQueryRs", "CreditMemoRet");
const extractFromInvoiceQuery = (r: unknown) =>
  extractRet(r, "InvoiceQueryRs", "InvoiceRet");
const extractFromSalesOrderQuery = (r: unknown) =>
  extractRet(r, "SalesOrderQueryRs", "SalesOrderRet");
const extractFromEstimateQuery = (r: unknown) =>
  extractRet(r, "EstimateQueryRs", "EstimateRet");
const extractFromSalesReceiptQuery = (r: unknown) =>
  extractRet(r, "SalesReceiptQueryRs", "SalesReceiptRet");

const STEP_FETCH_SPEC: Record<string, FetchSpec> = {
  credit_memo_mod: {
    endpoint: "/api/credit-memos",
    cacheEntityType: "credit_memo",
    persistTable: "pos_credit_memo",
    persistColumn: "qb_edit_sequence",
    extractEditSequence: extractFromCreditMemoQuery,
  },
  // The four specs below are cache-only backstops: their client functions
  // (client/invoices.ts, client/sales-orders.ts, client/estimates.ts,
  // client/sales-receipts.ts) already read qb_edit_sequence_cache first (or
  // do a full live re-fetch on every attempt) before every Mod, so this
  // covers only the rare double-stale race where BOTH the cache and their
  // own inline retry-once lost the race against a concurrent QB edit.
  invoice_update: {
    endpoint: "/api/invoices",
    cacheEntityType: "invoice",
    extractEditSequence: extractFromInvoiceQuery,
  },
  sales_order: {
    endpoint: "/api/sales-orders",
    cacheEntityType: "sales_order",
    extractEditSequence: extractFromSalesOrderQuery,
  },
  sales_order_mod: {
    endpoint: "/api/sales-orders",
    cacheEntityType: "sales_order",
    extractEditSequence: extractFromSalesOrderQuery,
  },
  so_close: {
    endpoint: "/api/sales-orders",
    cacheEntityType: "sales_order",
    extractEditSequence: extractFromSalesOrderQuery,
  },
  so_reopen: {
    endpoint: "/api/sales-orders",
    cacheEntityType: "sales_order",
    extractEditSequence: extractFromSalesOrderQuery,
  },
  estimate: {
    endpoint: "/api/estimates",
    cacheEntityType: "estimate",
    extractEditSequence: extractFromEstimateQuery,
  },
  estimate_mod: {
    endpoint: "/api/estimates",
    cacheEntityType: "estimate",
    extractEditSequence: extractFromEstimateQuery,
  },
  sales_receipt_update: {
    endpoint: "/api/sales-receipts",
    cacheEntityType: "sales_receipt",
    extractEditSequence: extractFromSalesReceiptQuery,
  },
};

/**
 * transfer_customer special-case: the fresh EditSequence must land in THIS
 * pipeline row's own `payload.editSequence` (jsonb), not a persistTable/
 * persistColumn on some other entity — resubmit-by-step.ts re-reads that
 * exact column on every retry. docType/endpoint depend on referenceType
 * ("sales_order" | "invoice"), set at dispatch time in
 * handle-customer-transferred.ts.
 */
async function refreshTransferCustomerEditSequence(
  txnId: string,
  referenceType: string | null | undefined,
  logger: { info: (m: string) => void; warn: (m: string) => void },
  pipelineRowId: string | null
): Promise<string | null> {
  const LOG_PREFIX = "[QB-AUTO-HEAL]";
  const isInvoice = referenceType === "invoice";
  const endpoint = isInvoice ? "/api/invoices" : "/api/sales-orders";
  const cacheEntityType = isInvoice ? "invoice" : "sales_order";
  const extract = isInvoice ? extractFromInvoiceQuery : extractFromSalesOrderQuery;

  if (!pipelineRowId) {
    logger.warn(
      `${LOG_PREFIX} transfer_customer: no pipelineRowId — cannot persist refreshed EditSequence`
    );
    return null;
  }

  let freshEditSeq: string | null = null;
  try {
    const queryResp = await bridgeFetch("GET", `${endpoint}/${txnId}`);
    const queryOpId = queryResp?.operationId;
    if (!queryOpId) {
      logger.warn(`${LOG_PREFIX} transfer_customer: bridge GET ${endpoint}/${txnId} returned no operationId`);
      return null;
    }
    const rawResult = await pollRawOperationResult(queryOpId, (m: string) => logger.info(`${LOG_PREFIX} ${m}`));
    freshEditSeq = extract(rawResult);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${LOG_PREFIX} transfer_customer: could not fetch fresh EditSequence for ${txnId}: ${msg}`);
    return null;
  }

  if (!freshEditSeq) {
    logger.warn(`${LOG_PREFIX} transfer_customer: QB returned no EditSequence for ${txnId}`);
    return null;
  }

  const pool = getDbPool();
  try {
    await pool.query(
      `UPDATE qb_order_pipeline
          SET payload = jsonb_set(COALESCE(payload, '{}'::jsonb), '{editSequence}', to_jsonb($2::text)),
              next_retry_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND status = 'failed'`,
      [pipelineRowId, freshEditSeq]
    );
    logger.info(`${LOG_PREFIX} ✅ transfer_customer: refreshed payload.editSequence on row ${pipelineRowId} → ${freshEditSeq}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${LOG_PREFIX} transfer_customer: could not update row ${pipelineRowId}: ${msg}`);
    return null;
  }

  try {
    await cacheEditSequence(cacheEntityType, txnId, freshEditSeq);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`${LOG_PREFIX} transfer_customer: could not cache new EditSequence: ${msg}`);
  }

  return freshEditSeq;
}

// Steps whose entity_type in qb_edit_sequence_cache differs from the step
// name itself (STEP_FETCH_SPEC already carries this for steps with a fetch
// recipe; this extends it to steps that self-heal without one — payment.ts/
// checks.ts fetch live every time and never read STEP_FETCH_SPEC, but the
// cache still needs the correct key so *other* callers reading it via
// getCachedEditSequence don't inherit a stale entry under the wrong type).
const STEP_TO_CACHE_ENTITY_TYPE: Record<string, string> = {
  payment_method_change: "payment",
  payment_txndate_change: "payment",
  refund_payment_txndate_change: "payment",
  refund_check_mod: "check",
  // Void/deactivate steps: they DO modify their document (that is what a void
  // is), so the poller caches the resulting EditSequence — but they have no
  // FetchSpec, so before this map they fell through to `?? step` and wrote
  // under their own step name. That entry is unreadable by construction: every
  // reader asks for the document's type. 114 such orphans had accumulated by
  // 2026-08-28 (35 void_sales_order, 13 estimate_deactivate, 6 void_estimate),
  // and while the base row kept a pre-void EditSequence nobody could tell it
  // was stale. They get no FetchSpec on purpose — auto-healing a voided
  // document's EditSequence would be re-staging a mod against a dead doc.
  void_sales_order: "sales_order",
  void_estimate: "estimate",
  estimate_deactivate: "estimate",
};

/**
 * Resolves the qb_edit_sequence_cache entity_type for a given pipeline step
 * — used to invalidate the CORRECT cache row on failure (before this, the
 * caller passed row.step directly, which only matched the cache for steps
 * whose step name equals their entity type, e.g. credit_memo_mod ≠
 * "credit_memo" cache key — that invalidate was a silent no-op).
 */
export function stepToCacheEntityType(
  step: string,
  referenceType?: string | null
): string {
  if (step === "transfer_customer") {
    return referenceType === "invoice" ? "invoice" : "sales_order";
  }
  const spec = STEP_FETCH_SPEC[step];
  if (spec) return spec.cacheEntityType;
  return STEP_TO_CACHE_ENTITY_TYPE[step] ?? step;
}

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
