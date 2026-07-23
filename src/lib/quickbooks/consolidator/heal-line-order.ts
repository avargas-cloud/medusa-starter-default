/**
 * Auto-heal for QB Error 3290 — "The item <TxnLineID> is placed in the request
 * in incorrect order."
 *
 * QB matches the lines of a *Mod against the lines it already holds and rejects
 * the whole request as soon as two EXISTING lines appear in a different
 * relative order than the document has them in. The bridge builders order
 * existing lines by ascending TxnLineID, which is correct only while lines are
 * exclusively APPENDED — QB hands out monotonically increasing ids, so the
 * newest line is also the last one.
 *
 * That invariant breaks whenever a line is inserted mid-document:
 *   - historically, by our own bug (a new line sent with the sentinel "-1" was
 *     sorted to the TOP of the request, so QB inserted it at position 1 and
 *     gave it the HIGHEST id on the document — see CM-1087 / 1C9684-1783534817,
 *     fixed in the bridge by sortLinesForMod), and
 *   - permanently, by a human inserting a line in the QB Desktop UI.
 *
 * Once that happens no amount of sorting can guess the truth, and the row spins
 * on 3290 forever. This module asks QB for the document's REAL line order and
 * stamps it onto the pipeline row's payload as `qbLineOrder`, which the bridge
 * builders treat as authoritative.
 *
 * Invoked from poll-submitted-rows on the failure path, next to the
 * EditSequence heal (refresh-edit-sequence.ts).
 */

import { getDbPool } from "../../../api/utils/db-pool";
import { bridgeFetch, pollRawOperationResult } from "../client/core";

const LOG_PREFIX = "[QB-LINE-ORDER-HEAL]";

interface LineOrderSpec {
  /** Bridge endpoint whose GET returns the document (with line items). */
  endpoint: string;
  /** *QueryRs key in the QBXML response envelope. */
  rsKey: string;
  /** *Ret key inside the *QueryRs. */
  retKey: string;
  /** Line-array keys on the *Ret, in the order QB nests them. */
  lineKeys: string[];
}

/**
 * Steps whose payload the bridge reads `qbLineOrder` from. Extend together:
 * a step listed here MUST also forward `qbLineOrder` from the pipeline payload
 * through its client function to the bridge, or the heal is a silent no-op.
 */
const STEP_LINE_ORDER_SPEC: Record<string, LineOrderSpec> = {
  credit_memo_mod: {
    endpoint: "/api/credit-memos",
    rsKey: "CreditMemoQueryRs",
    retKey: "CreditMemoRet",
    lineKeys: ["CreditMemoLineRet", "CreditMemoLineGroupRet"],
  },
};

/**
 * True when QB rejected the request purely because the lines were ordered
 * differently than the document holds them.
 */
export function isLineOrderError(message: string): boolean {
  if (!message) return false;
  return /\b3290\b|placed in the request in incorrect order/i.test(message);
}

/** Steps this module knows how to heal. */
export function canHealLineOrder(step: string): boolean {
  return !!STEP_LINE_ORDER_SPEC[step];
}

/**
 * Fetches the document's real line order from QB and persists it on the
 * pipeline row as `payload.qbLineOrder`, then re-arms the row for an immediate
 * retry. Returns the ordered TxnLineIDs, or null when the heal could not
 * complete (caller logs and lets normal failure handling stand).
 */
export async function healLineOrderForRow(
  step: string,
  txnId: string,
  logger: { info: (m: string) => void; warn: (m: string) => void },
  pipelineRowId: string | null | undefined
): Promise<string[] | null> {
  const spec = STEP_LINE_ORDER_SPEC[step];
  if (!spec) {
    logger.warn(
      `${LOG_PREFIX} No line-order recipe for step=${step} — cannot heal 3290`
    );
    return null;
  }
  if (!txnId) {
    logger.warn(`${LOG_PREFIX} No txnId for step=${step} — abort`);
    return null;
  }
  if (!pipelineRowId) {
    logger.warn(
      `${LOG_PREFIX} No pipelineRowId for ${step} ${txnId} — nowhere to persist the order`
    );
    return null;
  }

  let orderedLineIds: string[] = [];
  try {
    const queryResp = await bridgeFetch("GET", `${spec.endpoint}/${txnId}`);
    const queryOpId = queryResp?.operationId;
    if (!queryOpId) {
      logger.warn(
        `${LOG_PREFIX} Bridge GET ${spec.endpoint}/${txnId} returned no operationId`
      );
      return null;
    }
    const rawResult = await pollRawOperationResult(queryOpId, (m: string) =>
      logger.info(`${LOG_PREFIX} ${m}`)
    );
    orderedLineIds = extractLineOrder(rawResult, spec);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `${LOG_PREFIX} Could not read line order for ${step} ${txnId}: ${msg}`
    );
    return null;
  }

  if (orderedLineIds.length === 0) {
    // The bridge query builder must send <IncludeLineItems>true</IncludeLineItems>
    // for this step, otherwise QB returns the header only and there is nothing
    // to learn here.
    logger.warn(
      `${LOG_PREFIX} QB returned no line items for ${step} ${txnId} — is IncludeLineItems set on the query builder?`
    );
    return null;
  }

  const pool = getDbPool();
  try {
    // retry_count is reset alongside: the cause is deterministic and now fixed,
    // so the row deserves a fresh budget rather than dying on the retries it
    // burned while it was unfixable.
    await pool.query(
      `UPDATE qb_order_pipeline
          SET payload       = jsonb_set(
                                COALESCE(payload, '{}'::jsonb),
                                '{qbLineOrder}',
                                $2::jsonb
                              ),
              retry_count   = 0,
              next_retry_at = NOW(),
              updated_at    = NOW()
        WHERE id = $1 AND status = 'failed'`,
      [pipelineRowId, JSON.stringify(orderedLineIds)]
    );
    logger.info(
      `${LOG_PREFIX} ✅ Stamped QB line order on row ${pipelineRowId} (${step} ${txnId}): ${orderedLineIds.join(", ")}`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      `${LOG_PREFIX} Could not persist qbLineOrder on row ${pipelineRowId}: ${msg}`
    );
    return null;
  }

  return orderedLineIds;
}

/**
 * Walks the bridge's QBXML envelope to the document's line array and returns
 * the TxnLineIDs in the exact order QB listed them — that order IS the
 * document's line order.
 */
export function extractLineOrder(
  rawResult: unknown,
  spec: LineOrderSpec
): string[] {
  const r = rawResult as Record<string, any> | null;
  const msgs = r?.QBXML?.QBXMLMsgsRs ?? r?.QBXMLMsgsRs ?? {};
  const retRaw = msgs?.[spec.rsKey]?.[spec.retKey] ?? r?.[spec.retKey];
  const ret = Array.isArray(retRaw) ? retRaw[0] : retRaw;
  if (!ret) return [];

  const ids: string[] = [];
  for (const lineKey of spec.lineKeys) {
    const linesRaw = ret[lineKey];
    if (!linesRaw) continue;
    const lines = Array.isArray(linesRaw) ? linesRaw : [linesRaw];
    for (const line of lines) {
      const id = line?.TxnLineID;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return ids;
}
