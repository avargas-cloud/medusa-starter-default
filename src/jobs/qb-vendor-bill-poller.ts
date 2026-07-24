/**
 * src/jobs/qb-vendor-bill-poller.ts
 *
 * Phase 1 (item 1.2) of the Vendor Bill → QuickBooks Desktop sync
 * (`docs/VENDOR_BILL_QB_SYNC_PLAN.md` §5). Structural mirror of
 * `qb-item-receipt-poller.ts`, trimmed to the `add` lifecycle only.
 *
 * A `qb_vendor_bill_pipeline` row represents one QB `BillAdd` linked to a PO.
 * Unlike the ItemReceipt pipeline, this table has a real `submitted` status
 * (see table comment in the plan §3.3), so the lifecycle is the plain
 * `waiting → submitted → synced` / `error → failed_permanent` shape:
 *
 * Phase A — Submit: status='waiting', intent='add', qb_operation_id IS NULL
 *   → three gates (PO sync, legacy A/P, in-flight legacy receipt) → refresh
 *     any still-null `qb_po_txn_line_id` from live PO lines → POST
 *     /api/bills with a generation-aware Idempotency-Key → store
 *     qb_operation_id, status='submitted'.
 *
 * Phase B — Poll: status='submitted', qb_operation_id IS NOT NULL
 *   → GET /api/sync/status/:opId. On completion, extract BillRet
 *     TxnID/EditSequence/RefNumber + per-line TxnLineID and write back to
 *     `vendor_bill` + `vendor_bill_line`, mark the pipeline row 'synced'.
 *
 * Phase C — Retry: status='error', next_retry_at <= now
 *   → re-check all three Phase A gates (holds don't burn a retry), then
 *     re-submit like Phase A. MAX_RETRIES exhaustion → 'failed_permanent'.
 *
 * Phase D — Unlock (item 1.9, plan §6.2/§9 — SIMPLIFIED MVP, Fable design
 * decision 2026-07-23): `intent='unlock_rebuild'` rows, claimed by
 * `POST /admin/vendor-bills/:id/qb-unlock` (`lib/purchase-orders/
 * qb-vendor-bill-unlock.ts`). Delete-then-re-add BEHIND THE EXISTING GATES,
 * NOT the compound orchestrated state machine of §6.2 path A/B — that
 * surgical BillMod path stays deferred as a future optimization:
 *   1. BillQuery preflight (payload marker `__unlock_preflight`) — verify
 *      the bill is unpaid before touching it. Paid → ABORT, no QB mutation
 *      ever happens, row reverts to `intent='add'`/`status='synced'`.
 *   2. Unpaid → `TxnDel Bill` (payload marker `__unlock_delete`).
 *   3. Delete confirms → THE UNLOCK COMMIT: clear `vendor_bill`/pipeline QB
 *      fields, bump `rebuild_generation`, flip the row back to
 *      `intent='add'`/`status='waiting'`, and re-freeze its payload via
 *      `enqueueQbVendorBillAdd` (the PO edit may have changed quantities).
 * Correct ordering EMERGES from Phase A's existing `checkPoQbSyncGate` —
 * the re-`BillAdd` is naturally HELD until the PO's own QB mod syncs, no
 * extra state machine needed (Codex critical #2 avoided entirely).
 *
 * Still deliberately NOT in this pass:
 *   - `intent='mod'` (BillMod, surgical unlock path §6.2 A — a future
 *     optimization for pure-qty edits, not needed for the MVP)
 *   - `intent='void'` (TxnDel Bill for cancellations / live-test cleanup,
 *     §4.4/§5 Phase E — a different lifecycle from unlock: void never
 *     re-adds. Reuses the `void_status` column for a future chunk.)
 * Do not widen the Phase A–C filters (all `intent='add'`) as a "quick fix"
 * for either of these — a `mod`/`void` row picked up by the add lifecycle
 * would double-post or corrupt the pipeline row's own state machine.
 *
 * Behind `QB_VENDOR_BILL_MODE`: only Phase A is flag-gated (dormant when the
 * flag isn't 'bill' — the confirm route that enqueues rows is flag-gated
 * upstream too, so this is belt-and-suspenders). Phases B/C/D always run so
 * anything already in flight (including a claimed unlock) drains even if
 * the flag is flipped off mid-way.
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { pollBridgeStatus } from "../lib/quickbooks/bridge-fetch";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
import {
  markStaleRowsAsFailed,
  STANDARD_STALE_CONFIG,
} from "../lib/quickbooks/stale-row-cleanup";
import { checkPoQbSyncGate } from "../lib/purchase-orders/po-qb-sync-gate";
import { enqueueQbVendorBillAdd } from "../lib/purchase-orders/qb-vendor-bill-enqueue";

const bridgeUrl = (): string =>
  process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const apiKey = (): string => process.env.QB_API_KEY || "";
const MAX_ROWS_PER_TICK = 30;
const MAX_RETRIES = 5;
const RETRY_BACKOFF_MIN: readonly number[] = [2, 4, 10, 30, 60] as const;
const FIRST_ERROR_BACKOFF_MIN = 2;
const GATE_HOLD_RECHECK_MIN = 5;

const backoffMs = (retryNum: number): number =>
  (RETRY_BACKOFF_MIN[Math.min(retryNum, RETRY_BACKOFF_MIN.length - 1)] ??
    FIRST_ERROR_BACKOFF_MIN) * 60_000;

// ── knex-shaped types (mirrors the `__pg_connection__` resolve pattern used
// across every QB poller/route in this codebase) ───────────────────────────
export type KnexRaw = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
  transaction?: () => Promise<
    KnexRaw & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

// ── Gate/fence result shape (shared by the PO-sync gate reuse and the two
// fences this file exports) ─────────────────────────────────────────────────
export type BillDispatchGate =
  | { blocked: false }
  | { blocked: true; reason: string };

/**
 * Transition hazard #1 (plan §9, Codex CRITICAL): a PO that already has a
 * *synced* legacy ItemReceipt in QuickBooks has A/P posted via that receipt.
 * Sending a BillAdd for the same PO before that receipt is deleted/adopted
 * would double-post A/P. Blocks on any live (non-deleted) receipt row for
 * this PO with `qb_item_receipt_list_id` set — once the receipt is deleted
 * from QB, `qb-item-receipt-poller` Phase E hard-deletes the row, so it
 * naturally drops out of this query. The reconciliation pass (plan §10,
 * Phase 3, not built yet) is what "adopts" or clears these; until it ships
 * this fence just parks the row with a clear reason.
 */
export async function checkLegacyApFence(
  knex: KnexRaw,
  purchaseOrderId: string
): Promise<BillDispatchGate> {
  const rows = (await knex
    .raw(
      `SELECT id, number, qb_item_receipt_list_id
         FROM purchase_order_receipt
        WHERE purchase_order_id = ?
          AND qb_item_receipt_list_id IS NOT NULL
          AND deleted_at IS NULL
        LIMIT 5`,
      [purchaseOrderId]
    )
    .then((r) => r.rows)) as Array<{
    id: string;
    number: string | null;
    qb_item_receipt_list_id: string;
  }>;

  if (!rows.length) return { blocked: false };

  const labels = rows.map((r) => r.number ?? r.id).join(", ");
  return {
    blocked: true,
    reason:
      `Held: legacy A/P fence — PO has ${rows.length} synced ItemReceipt(s) still ` +
      `live in QuickBooks (${labels}). Sending a Bill now would double-post A/P. ` +
      `The legacy receipt(s) must be deleted or adopted (plan §10 reconciliation) ` +
      `before this Bill can be dispatched.`,
  };
}

/**
 * Transition hazard #2 (plan §9): an in-flight legacy `qb_item_receipt_pipeline`
 * row (still on its way to `synced` or `failed_permanent`) can still post A/P
 * after the flag flips to 'bill'. Mutual fence with the item-receipt poller:
 * no BillAdd while any item-receipt pipeline row for this PO hasn't reached a
 * terminal state. `synced` rows are covered separately by the legacy A/P
 * fence above; `failed_permanent` never posted anything, so it's terminal
 * here too.
 */
export async function checkInFlightReceiptFence(
  knex: KnexRaw,
  purchaseOrderId: string
): Promise<BillDispatchGate> {
  const rows = (await knex
    .raw(
      `SELECT id, status
         FROM qb_item_receipt_pipeline
        WHERE purchase_order_id = ?
          AND deleted_at IS NULL
          AND status IN ('waiting', 'submitted', 'error')
        LIMIT 5`,
      [purchaseOrderId]
    )
    .then((r) => r.rows)) as Array<{ id: string; status: string }>;

  if (!rows.length) return { blocked: false };

  const statuses = [...new Set(rows.map((r) => r.status))].join("/");
  return {
    blocked: true,
    reason:
      `Held: in-flight legacy ItemReceipt fence — PO has ${rows.length} ` +
      `qb_item_receipt_pipeline row(s) not yet terminal (status ${statuses}) that ` +
      `could still post A/P after this Bill syncs. Waiting for those to finish ` +
      `(synced or failed_permanent).`,
  };
}

/**
 * Park an ADD row on a gate without burning a retry. Mirrors
 * `holdRowForPoSync` in qb-item-receipt-poller.ts: `updated_at` is refreshed
 * on purpose so the hold reads as deliberate, not stuck, to
 * `markStaleRowsAsFailed`. The reason lives in `last_error` for the QB
 * pipeline UI to render.
 */
const holdRow = async (
  knex: KnexRaw,
  rowId: string,
  reason: string,
  nextRetryAt: "keep" | "defer"
): Promise<void> => {
  if (nextRetryAt === "defer") {
    await knex.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET last_error = ?,
              next_retry_at = NOW() + INTERVAL '${GATE_HOLD_RECHECK_MIN} minutes',
              updated_at = NOW()
        WHERE id = ?`,
      [reason, rowId]
    );
    return;
  }
  await knex.raw(
    `UPDATE qb_vendor_bill_pipeline
        SET last_error = ?,
            updated_at = NOW()
      WHERE id = ?`,
    [reason, rowId]
  );
};

/**
 * Runs the three Phase-A dispatch gates in order. Returns the first blocking
 * gate, or `{ blocked: false }` if the row is clear to dispatch. Shared by
 * Phase A (fresh dispatch) and Phase C (retry) — both must re-check all
 * three before spending a bridge call.
 */
const checkAllDispatchGates = async (
  knex: KnexRaw,
  purchaseOrderId: string
): Promise<BillDispatchGate> => {
  const poGate = await checkPoQbSyncGate(knex, purchaseOrderId);
  if (poGate.blocked) return { blocked: true, reason: poGate.reason };

  const apFence = await checkLegacyApFence(knex, purchaseOrderId);
  if (apFence.blocked) return apFence;

  const inFlightFence = await checkInFlightReceiptFence(knex, purchaseOrderId);
  if (inFlightFence.blocked) return inFlightFence;

  return { blocked: false };
};

// ── Bridge status polling (identical shape/rationale to the other pollers —
// see bridge-fetch.ts for the 404→"expired" synthesis) ──────────────────────
type BridgeStatus = {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed" | "expired";
    error?: string;
    txnId?: string;
    listId?: string;
    refNumber?: string;
    editSequence?: string;
    result?: unknown;
  };
};

const pollBridge = async (operationId: string): Promise<BridgeStatus> => {
  const result = await pollBridgeStatus(operationId);
  if (result.status === "expired") {
    return {
      operation: {
        status: "expired",
        error:
          "Bridge operation expired (HTTP 404). Op no longer in bridge queue.",
      },
    } as BridgeStatus;
  }
  return result.data as BridgeStatus;
};

const submitAddToBridge = async (
  payload: Record<string, unknown>,
  idempotencyKey: string
): Promise<string> => {
  const res = await fetch(`${bridgeUrl()}/api/bills`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
      // ADD-only dedupe (plan §4.5) — generation-aware so an unlock/rebuild
      // (which bumps rebuild_generation) is never suppressed, while re-
      // dispatch of the SAME generation is deduped by the bridge middleware.
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

/**
 * Refreshes null `qb_po_txn_line_id` values in a frozen bill payload before
 * submitting to the bridge. Same race condition the item-receipt poller
 * guards against (`refreshNullPoLineIds`): a PO amendment's line IDs get
 * written back to `purchase_order_line` AFTER this bill's payload was
 * frozen by the confirm route. Without this, the builder omits `LinkToTxn`
 * on that line. Persists the refreshed payload so retries don't re-check.
 */
const refreshNullPoTxnLineIds = async (
  knex: KnexRaw,
  logger: { info: (m: string) => void; warn: (m: string) => void },
  tag: string,
  payload: Record<string, unknown>,
  rowId: string
): Promise<Record<string, unknown>> => {
  const itemLines = payload.item_lines as
    | Array<Record<string, unknown>>
    | undefined;
  if (!itemLines?.length) return payload;

  const nullLineIds = itemLines
    .filter(
      (l) => l.qb_po_txn_line_id === null || l.qb_po_txn_line_id === undefined
    )
    .map((l) => l.vendor_bill_line_id as string | undefined)
    .filter((v): v is string => !!v);
  if (!nullLineIds.length) return payload;

  const freshRows = (await knex
    .raw(
      `SELECT vbl.id, pol.qb_txn_line_id
         FROM vendor_bill_line vbl
         JOIN purchase_order_line pol ON pol.id = vbl.purchase_order_line_id
        WHERE vbl.id = ANY(?::text[])`,
      [nullLineIds]
    )
    .then((r) => r.rows)) as Array<{
    id: string;
    qb_txn_line_id: string | null;
  }>;

  const anyFresh = freshRows.some((r) => r.qb_txn_line_id !== null);
  if (!anyFresh) {
    logger.warn(
      `${tag} row ${rowId}: ${nullLineIds.length} item line(s) still have no ` +
        `qb_po_txn_line_id after DB refresh — PO change may not be confirmed ` +
        `in QB yet; bill will be submitted with those lines unlinked`
    );
    return payload;
  }

  const freshById = new Map(freshRows.map((r) => [r.id, r.qb_txn_line_id]));
  const refreshedItemLines = itemLines.map((l) => ({
    ...l,
    qb_po_txn_line_id:
      (l.qb_po_txn_line_id as string | null) ??
      freshById.get(l.vendor_bill_line_id as string) ??
      null,
  }));

  const refreshedPayload = { ...payload, item_lines: refreshedItemLines };
  await knex.raw(
    `UPDATE qb_vendor_bill_pipeline SET payload = ?::jsonb, updated_at = NOW() WHERE id = ?`,
    [JSON.stringify(refreshedPayload), rowId]
  );
  logger.info(
    `${tag} row ${rowId}: refreshed ${nullLineIds.length} null qb_po_txn_line_id(s) from DB before submit`
  );
  return refreshedPayload;
};

// ── Response extraction ─────────────────────────────────────────────────────
const extractMsgs = (data: BridgeStatus): Record<string, unknown> => {
  const op = data.operation;
  return (
    ((op?.result as any)?.QBXML?.QBXMLMsgsRs as Record<string, unknown>) ??
    ((op?.result as any)?.QBXMLMsgsRs as Record<string, unknown>) ??
    {}
  );
};

const extractBillRet = (data: BridgeStatus): any => {
  const msgs = extractMsgs(data);
  const ret = (msgs as any)?.BillAddRs?.BillRet ?? null;
  return Array.isArray(ret) ? (ret[0] ?? null) : ret;
};

/**
 * The bridge can mark an operation "completed" (the QBXML round-trip
 * succeeded) while the embedded response is itself a QB error
 * (statusCode != "0") — same convention as `qb-purchase-order-poller.ts`.
 * Checked before treating a "completed" op as a success.
 */
const extractQbResponseError = (data: BridgeStatus): string | null => {
  const msgs = extractMsgs(data);
  const rs = (msgs as any)?.BillAddRs;
  if (!rs) return null;
  const code = String(rs.statusCode ?? rs["@statusCode"] ?? "0");
  if (code === "0") return null;
  const msg =
    rs.statusMessage ?? rs["@statusMessage"] ?? `QB BillAddRs statusCode=${code}`;
  return `QuickBooks Error ${code}: ${msg}`;
};

const extractTxnId = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (op?.txnId) return op.txnId;
  if (op?.listId) return op.listId;
  return extractBillRet(data)?.TxnID ?? null;
};

const extractRefNumber = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (op?.refNumber) return op.refNumber;
  return extractBillRet(data)?.RefNumber ?? null;
};

const extractEditSequence = (data: BridgeStatus): string | null => {
  const op = data.operation;
  if (op?.editSequence) return op.editSequence;
  return extractBillRet(data)?.EditSequence ?? null;
};

const toArray = <T,>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];

const extractItemLineRets = (
  data: BridgeStatus
): Array<{ TxnLineID?: string }> => toArray(extractBillRet(data)?.ItemLineRet);

const extractExpenseLineRets = (
  data: BridgeStatus
): Array<{ TxnLineID?: string }> =>
  toArray(extractBillRet(data)?.ExpenseLineRet);

// ── Expired-op existence check ──────────────────────────────────────────────
// A bridge op 404s ("expired") exactly when the bridge restarted — which is
// also when its in-memory Idempotency-Key ledger died. If the original
// BillAdd COMMITTED in QB before the crash, a blind re-submit mints a
// DUPLICATE Bill (same failure class as the CM-1081 dup, 2026-07-01: the
// ledger is a latency-window suppressor, NOT exactly-once). So an expired
// ADD is never re-submitted blindly: we first run a read-only BillQuery over
// the bill's TxnDate and look for our own bill; found → adopt it as synced,
// verified-absent → only then re-submit.
const EXPIRED_OP_PREFIX = "EXPIRED_OP:";
const EXISTENCE_CHECK_KEY = "__existence_check";

const submitExistenceQueryToBridge = async (
  payload: Record<string, unknown>
): Promise<string> => {
  const res = await fetch(`${bridgeUrl()}/api/bills/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify({
      from_date: payload.txn_date,
      to_date: payload.txn_date,
      max_returned: 200,
    }),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

const extractQueryBillRets = (data: BridgeStatus): any[] => {
  const msgs = extractMsgs(data);
  return toArray((msgs as any)?.BillQueryRs?.BillRet);
};

/**
 * Finds OUR bill among the day's bills: same vendor AND (exact Memo match —
 * the dispatch memo embeds the VB/PO numbers — or, as fallback, exact
 * RefNumber match). Vendor alone is never enough (an agent vendor can have
 * several bills the same day).
 */
const findExistingBillMatch = (
  candidates: any[],
  payload: Record<string, unknown>
): any | null => {
  const vendorListId = String(payload.vendor_qb_list_id ?? "");
  const memo = typeof payload.memo === "string" ? payload.memo : "";
  const refNumber =
    typeof payload.ref_number === "string" ? payload.ref_number : "";
  for (const c of candidates) {
    const sameVendor =
      !vendorListId || String(c?.VendorRef?.ListID ?? "") === vendorListId;
    if (!sameVendor) continue;
    if (memo && String(c?.Memo ?? "") === memo) return c;
    if (refNumber && String(c?.RefNumber ?? "") === refNumber) return c;
  }
  return null;
};

/**
 * `qb_po_txn_line_id` sort key used to reconstruct the exact order the
 * bridge builder emitted `ItemLineAdd` elements in (plan §4.1: item lines go
 * out in ascending PO-line order for QB 3210). Numeric-ish values compare
 * numerically; anything else falls back to string compare so a malformed/
 * missing id never throws.
 */
const compareQbLineIds = (a: unknown, b: unknown): number => {
  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);
  const aIsNum = a !== null && a !== undefined && a !== "" && !Number.isNaN(na);
  const bIsNum = b !== null && b !== undefined && b !== "" && !Number.isNaN(nb);
  if (aIsNum && bIsNum) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
};

type BillItemLinePayload = {
  vendor_bill_line_id?: string;
  qb_po_txn_line_id?: string | number | null;
};
type BillExpenseLinePayload = { vendor_bill_line_id?: string };

/**
 * Writes QB's returned TxnID/EditSequence/RefNumber + per-line TxnLineID
 * back to `qb_vendor_bill_pipeline` + `vendor_bill` + `vendor_bill_line`.
 * Transactional when the resolved knex supports it (same optional-transaction
 * pattern used by `vendor-bills/[id]/reopen/route.ts`) so a mid-write
 * failure never leaves the pipeline row 'synced' with only half the lines
 * stamped — it just stays 'submitted' and the next poll retries the writes
 * against the same (still-completed) bridge op.
 */
const persistSyncedBill = async (
  knex: KnexRaw,
  row: {
    id: string;
    vendor_bill_id: string;
    payload: Record<string, unknown>;
  },
  txnId: string,
  refNumber: string | null,
  editSequence: string | null,
  itemLineRets: Array<{ TxnLineID?: string }>,
  expenseLineRets: Array<{ TxnLineID?: string }>
): Promise<void> => {
  const itemLines = (row.payload.item_lines ?? []) as BillItemLinePayload[];
  const expenseLines = (row.payload.expense_lines ??
    []) as BillExpenseLinePayload[];

  // Re-sort to the exact order the bridge submitted ItemLineAdd elements in
  // (ascending qb_po_txn_line_id) so positional TxnLineID mapping is correct.
  // Expense lines are NOT re-sorted — the builder emits them in payload order.
  const sortedItemLines = [...itemLines].sort((a, b) =>
    compareQbLineIds(a.qb_po_txn_line_id, b.qb_po_txn_line_id)
  );

  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    const n = Math.min(sortedItemLines.length, itemLineRets.length);
    for (let i = 0; i < n; i++) {
      const lineId = sortedItemLines[i]?.vendor_bill_line_id;
      const txnLineId = itemLineRets[i]?.TxnLineID;
      if (!lineId || !txnLineId) continue;
      await db.raw(
        `UPDATE vendor_bill_line SET qb_txn_line_id = ?, updated_at = NOW() WHERE id = ?`,
        [txnLineId, lineId]
      );
    }

    const m = Math.min(expenseLines.length, expenseLineRets.length);
    for (let i = 0; i < m; i++) {
      const lineId = expenseLines[i]?.vendor_bill_line_id;
      const txnLineId = expenseLineRets[i]?.TxnLineID;
      if (!lineId || !txnLineId) continue;
      await db.raw(
        `UPDATE vendor_bill_line SET qb_txn_line_id = ?, updated_at = NOW() WHERE id = ?`,
        [txnLineId, lineId]
      );
    }

    await db.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET status = 'synced',
              qb_txn_id = ?,
              qb_ref_number = COALESCE(?, qb_ref_number),
              edit_sequence = ?,
              synced_at = NOW(),
              last_error = NULL,
              next_retry_at = NULL,
              updated_at = NOW()
        WHERE id = ?`,
      [txnId, refNumber, editSequence, row.id]
    );

    // `locks_po` is derived (status='synced' AND not voided) on this schema
    // iteration — plan §3.1 lists it as "derived or stored"; no dedicated
    // column exists yet, so readers should derive it from vendor_bill.status.
    await db.raw(
      `UPDATE vendor_bill
          SET qb_txn_id = ?,
              qb_edit_sequence = COALESCE(?, qb_edit_sequence),
              qb_ref_number = COALESCE(?, qb_ref_number),
              qb_synced_at = NOW(),
              qb_source = 'owned',
              status = 'synced',
              updated_at = NOW()
        WHERE id = ?`,
      [txnId, editSequence, refNumber, row.vendor_bill_id]
    );

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }
};

// ── Phase D: Unlock (item 1.9 — SIMPLIFIED MVP) ─────────────────────────────
// Payload markers distinguish the two Phase-D sub-steps on a row already
// claimed (`intent='unlock_rebuild'`) by `claimUnlock` — same in-payload-
// marker technique as the ADD lane's `__existence_check` above.
const UNLOCK_PREFLIGHT_KEY = "__unlock_preflight";
const UNLOCK_DELETE_KEY = "__unlock_delete";

const submitUnlockPreflightQueryToBridge = async (
  qbTxnId: string
): Promise<string> => {
  const res = await fetch(`${bridgeUrl()}/api/bills/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify({ txn_id: qbTxnId, max_returned: 5 }),
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

const submitUnlockDeleteToBridge = async (qbTxnId: string): Promise<string> => {
  // Del over Void (plan §4.4): a Bill TxnDel releases the PO quantities and
  // reverses the A/P + inventory it posted, leaving no $0 audit shell.
  const res = await fetch(`${bridgeUrl()}/api/bills/${qbTxnId}`, {
    method: "DELETE",
    headers: {
      "x-api-key": apiKey(),
      "bypass-tunnel-reminder": "true",
    },
  });
  if (!res.ok)
    throw new Error(`Bridge HTTP ${res.status} — ${await res.text()}`);
  const json = (await res.json()) as { operationId?: string; error?: string };
  if (!json.operationId)
    throw new Error(json.error ?? "Bridge returned no operationId");
  return json.operationId;
};

/** First BillRet matching the queried TxnID; falls back to the first result
 * so a bridge that doesn't echo TxnID back verbatim still resolves. */
const extractBillRetByTxnId = (data: BridgeStatus, txnId: string): any | null => {
  const candidates = extractQueryBillRets(data);
  return (
    candidates.find((c) => String(c?.TxnID ?? "") === txnId) ??
    candidates[0] ??
    null
  );
};

/** IsPaid is the QBXML paid flag; PaidStatus is a defensive fallback for any
 * bridge/company-file variant that surfaces payment state differently. */
const isBillPaid = (billRet: any): boolean => {
  const raw = billRet?.IsPaid;
  if (raw === true || raw === "true" || raw === "1") return true;
  const paidStatus = String(billRet?.PaidStatus ?? billRet?.["@PaidStatus"] ?? "");
  return /paid/i.test(paidStatus) && !/unpaid/i.test(paidStatus);
};

/** `TxnDelRs` statusCode 3120 ("object cannot be found") is treated as
 * success — the Bill is already gone, exactly the state we want. */
const extractTxnDelStatus = (data: BridgeStatus): { code: string; msg: string } => {
  const msgs = extractMsgs(data);
  const rs = (msgs as any)?.TxnDelRs;
  const code = String(rs?.statusCode ?? rs?.["@statusCode"] ?? "0");
  const msg =
    rs?.statusMessage ?? rs?.["@statusMessage"] ?? `QB TxnDelRs statusCode=${code}`;
  return { code, msg };
};

/**
 * The unlock commit: runs after the `TxnDel Bill` confirms. Clears the QB
 * identity off both `vendor_bill` and the pipeline row's own mirror columns,
 * bumps `rebuild_generation` (plan §4.5 — a new generation is never
 * dedupe-suppressed), and flips the row back to the normal add lifecycle.
 * The transaction covers only the two clearing UPDATEs; `enqueueQbVendorBillAdd`
 * runs AFTER commit (it does its own UPDATE-first against the now-'waiting'
 * row) so a transaction that has already committed is never mistaken for a
 * failure by the caller.
 */
const commitUnlockDelete = async (
  knex: KnexRaw,
  logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
  tag: string,
  row: { id: string; vendor_bill_id: string }
): Promise<void> => {
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    await db.raw(
      `UPDATE vendor_bill
          SET qb_txn_id = NULL,
              qb_edit_sequence = NULL,
              qb_ref_number = NULL,
              qb_synced_at = NULL,
              updated_at = NOW()
        WHERE id = ?`,
      [row.vendor_bill_id]
    );
    await db.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET intent = 'add',
              status = 'waiting',
              qb_operation_id = NULL,
              qb_txn_id = NULL,
              qb_ref_number = NULL,
              edit_sequence = NULL,
              payload = (payload - ?) - ?,
              rebuild_generation = rebuild_generation + 1,
              retries = 0,
              last_error = NULL,
              next_retry_at = NULL,
              updated_at = NOW()
        WHERE id = ?`,
      [UNLOCK_PREFLIGHT_KEY, UNLOCK_DELETE_KEY, row.id]
    );
    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  // Best-effort from here: the unlock itself already committed above (QB
  // Bill deleted, PO free to edit). A failure past this point just leaves
  // the row 'waiting'/'add' with its pre-unlock payload — Phase A picks it
  // up on the next tick regardless, so this never strands the rebuild.
  try {
    const enqueueResult = await enqueueQbVendorBillAdd(knex, row.vendor_bill_id);
    if (!enqueueResult.queued) {
      logger.warn(
        `${tag} row ${row.id}: unlock commit succeeded but the re-add refresh ` +
          `did not queue (${enqueueResult.reason}) — row left 'waiting' with its ` +
          `pre-unlock payload; investigate before the user's PO edit lands`
      );
      return;
    }
    await knex.raw(
      `UPDATE qb_vendor_bill_pipeline
          SET last_error = 'Unlocked — QB bill deleted; will re-add after the PO edit syncs',
              updated_at = NOW()
        WHERE id = ?`,
      [row.id]
    );
  } catch (err: any) {
    logger.error(
      `${tag} row ${row.id}: unlock commit succeeded but the re-add payload ` +
        `refresh threw — will still re-add with the pre-unlock payload on the ` +
        `next Phase A tick: ${err.message}`
    );
  }
};

export default async function qbVendorBillPoller(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as any;
  const knex = (container as any).resolve("__pg_connection__") as KnexRaw;

  const TAG = "[qb-vb-poller]";
  const billModeEnabled = process.env.QB_VENDOR_BILL_MODE === "bill";

  await markStaleRowsAsFailed(
    knex as any,
    "qb_vendor_bill_pipeline",
    STANDARD_STALE_CONFIG,
    { warn: (m) => logger.warn?.(`${TAG} ${m}`) }
  );

  let submitted = 0;
  let resolved = 0;
  let toError = 0;
  let retried = 0;
  let permaFailed = 0;
  let held = 0;
  let unlockSubmitted = 0;
  let unlockAborted = 0;
  let unlockCommitted = 0;
  let unlockError = 0;

  // ── Phase A: Submit unsubmitted ADD rows ──────────────────────────────────
  // Flag-gated: the confirm route that enqueues these rows is itself gated
  // on QB_VENDOR_BILL_MODE (plan §9), so this is belt-and-suspenders — but
  // it also means the poller stays fully dormant (zero bridge calls) until
  // the flag flips, even if a row somehow landed in 'waiting' beforehand.
  if (!billModeEnabled) {
    logger.info?.(
      `${TAG} QB_VENDOR_BILL_MODE != 'bill' — Phase A dormant this tick (B/C still drain in-flight rows)`
    );
  } else {
    const unsubmitted = (await knex
      .raw(
        `SELECT id, vendor_bill_id, purchase_order_id, payload, rebuild_generation
           FROM qb_vendor_bill_pipeline
          WHERE status = 'waiting'
            AND intent = 'add'
            AND qb_operation_id IS NULL
            AND deleted_at IS NULL
          LIMIT ?`,
        [MAX_ROWS_PER_TICK]
      )
      .then((r) => r.rows)) as Array<{
      id: string;
      vendor_bill_id: string;
      purchase_order_id: string;
      payload: Record<string, unknown>;
      rebuild_generation: number;
    }>;

    if (unsubmitted.length > 0) {
      logger.info(
        `${TAG} phase A: submitting ${unsubmitted.length} unsubmitted rows`
      );
    }

    for (const row of unsubmitted) {
      const gate = await checkAllDispatchGates(knex, row.purchase_order_id);
      if (gate.blocked) {
        await holdRow(knex, row.id, gate.reason, "keep");
        held++;
        logger.warn(`${TAG} row ${row.id} held: ${gate.reason}`);
        continue;
      }

      try {
        const freshPayload = await refreshNullPoTxnLineIds(
          knex, logger, TAG, row.payload, row.id
        );
        const idempotencyKey = `vendor-bill:${row.vendor_bill_id}:g${row.rebuild_generation ?? 0}`;
        const operationId = await submitAddToBridge(freshPayload, idempotencyKey);
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET qb_operation_id = ?,
                  status = 'submitted',
                  updated_at = NOW()
            WHERE id = ?`,
          [operationId, row.id]
        );
        submitted++;
      } catch (err: any) {
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'error',
                  last_error = ?,
                  next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [err.message, row.id]
        );
        toError++;
        logger.error(`${TAG} submit failed for row ${row.id}: ${err.message}`);
      }
    }
  }

  // ── Phase B: Poll submitted ADD rows ─────────────────────────────────────
  const polling = (await knex
    .raw(
      `SELECT id, vendor_bill_id, purchase_order_id, payload, qb_operation_id
         FROM qb_vendor_bill_pipeline
        WHERE status = 'submitted'
          AND intent = 'add'
          AND qb_operation_id IS NOT NULL
          AND deleted_at IS NULL
        LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r) => r.rows)) as Array<{
    id: string;
    vendor_bill_id: string;
    purchase_order_id: string;
    payload: Record<string, unknown>;
    qb_operation_id: string;
  }>;

  if (polling.length > 0) {
    logger.info(`${TAG} phase B: polling ${polling.length} submitted rows`);
  }

  for (const row of polling) {
    try {
      const data = await pollBridge(row.qb_operation_id);
      const opStatus = data.operation?.status;

      if (!opStatus || opStatus === "queued" || opStatus === "processing")
        continue;

      // ── Existence-check rows: this op is a read-only BillQuery, not an
      // Add. Resolve the "did the expired Add actually commit?" question.
      if (row.payload?.[EXISTENCE_CHECK_KEY] === true) {
        if (opStatus === "failed" || opStatus === "expired") {
          // Couldn't verify — back to the EXPIRED_OP error state to try the
          // check again (never falls through to a blind re-submit).
          await knex.raw(
            `UPDATE qb_vendor_bill_pipeline
                SET status = 'error',
                    qb_operation_id = NULL,
                    payload = payload - ?,
                    last_error = ?,
                    next_retry_at = NOW() + INTERVAL '2 minutes',
                    updated_at = NOW()
              WHERE id = ?`,
            [
              EXISTENCE_CHECK_KEY,
              `${EXPIRED_OP_PREFIX} existence check ${opStatus} — retrying verification`,
              row.id,
            ]
          );
          toError++;
          continue;
        }
        const match = findExistingBillMatch(
          extractQueryBillRets(data),
          row.payload
        );
        if (match?.TxnID) {
          // The original Add DID commit before the bridge died — adopt it.
          logger.warn(
            `${TAG} row ${row.id}: expired Add HAD committed in QB (TxnID ${match.TxnID}) — adopting, no re-submit`
          );
          await persistSyncedBill(
            knex,
            row,
            String(match.TxnID),
            match.RefNumber ? String(match.RefNumber) : null,
            match.EditSequence ? String(match.EditSequence) : null,
            toArray(match.ItemLineRet),
            toArray(match.ExpenseLineRet)
          );
          await knex.raw(
            `UPDATE qb_vendor_bill_pipeline
                SET payload = payload - ?, updated_at = NOW()
              WHERE id = ?`,
            [EXISTENCE_CHECK_KEY, row.id]
          );
          resolved++;
        } else {
          // Verified absent → safe to re-submit the Add from Phase A.
          await knex.raw(
            `UPDATE qb_vendor_bill_pipeline
                SET status = 'waiting',
                    qb_operation_id = NULL,
                    payload = payload - ?,
                    last_error = 'Expired op verified NOT in QB — re-submitting',
                    updated_at = NOW()
              WHERE id = ?`,
            [EXISTENCE_CHECK_KEY, row.id]
          );
        }
        continue;
      }

      if (opStatus === "expired") {
        // Bridge no longer knows this op — typically a bridge restart, which
        // ALSO wiped the in-memory Idempotency-Key ledger, so a blind
        // re-submit could mint a duplicate Bill if the original committed.
        // Route through the existence check instead (Phase C picks it up).
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'error',
                  qb_operation_id = NULL,
                  last_error = ?,
                  next_retry_at = NOW() + INTERVAL '2 minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [
            `${EXPIRED_OP_PREFIX} ${data.operation?.error ?? "Bridge operation expired"} — will verify in QB before re-submitting`,
            row.id,
          ]
        );
        toError++;
        continue;
      }

      if (opStatus === "failed") {
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'error',
                  last_error = ?,
                  next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [data.operation?.error ?? "Bridge returned failed", row.id]
        );
        toError++;
        continue;
      }

      // opStatus === "completed" from here down. The QBXML round-trip can
      // still carry a QB-side rejection (statusCode != "0") inside a
      // nominally "completed" bridge op — check before treating as success.
      const qbErr = extractQbResponseError(data);
      if (qbErr) {
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'error',
                  last_error = ?,
                  next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [qbErr, row.id]
        );
        toError++;
        continue;
      }

      const txnId = extractTxnId(data);
      if (!txnId) {
        // Race-condition guard (same as the other pollers): bridge can flip
        // to 'completed' momentarily before result/error is populated.
        if (!data.operation?.error) {
          logger.info(
            `${TAG} row ${row.id}: bridge status='${opStatus}' but no txnId/error yet — polling again next tick`
          );
          continue;
        }
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'error',
                  last_error = ?,
                  next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [
            `Completed but no TxnID in response: ${data.operation.error}`,
            row.id,
          ]
        );
        toError++;
        continue;
      }

      const refNumber = extractRefNumber(data);
      const editSequence = extractEditSequence(data);
      const itemLineRets = extractItemLineRets(data);
      const expenseLineRets = extractExpenseLineRets(data);

      try {
        await persistSyncedBill(
          knex, row, txnId, refNumber, editSequence, itemLineRets, expenseLineRets
        );
      } catch (writeErr: any) {
        // Leave the row 'submitted' with the same qb_operation_id — the
        // bridge op is already completed, so the next tick re-polls the
        // same result and retries the write (all UPDATEs here are
        // idempotent SETs, safe to redo).
        logger.error(
          `${TAG} row ${row.id}: QB confirmed TxnID=${txnId} but the local write failed — will retry write next tick: ${writeErr.message}`
        );
        continue;
      }

      resolved++;
      logger.info(
        `${TAG} bill ${row.vendor_bill_id} synced → QB TxnID=${txnId}` +
          `${refNumber ? ` Ref=${refNumber}` : ""}${editSequence ? ` EditSeq=${editSequence}` : ""}`
      );
    } catch (err: any) {
      logger.warn(`${TAG} poll failed for row ${row.id}: ${err.message}`);
    }
  }

  // ── Phase C: Retry error rows ─────────────────────────────────────────────
  const errorRows = (await knex
    .raw(
      `SELECT id, vendor_bill_id, purchase_order_id, payload, retries, rebuild_generation, last_error
         FROM qb_vendor_bill_pipeline
        WHERE status = 'error'
          AND intent = 'add'
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          AND deleted_at IS NULL
        LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r) => r.rows)) as Array<{
    id: string;
    vendor_bill_id: string;
    purchase_order_id: string;
    payload: Record<string, unknown>;
    retries: number | null;
    rebuild_generation: number;
    last_error: string | null;
  }>;

  if (errorRows.length > 0) {
    logger.info(`${TAG} phase C: retrying ${errorRows.length} error rows`);
  }

  for (const row of errorRows) {
    // Expired-op rows verify existence in QB BEFORE any re-submit (read-only
    // query — runs even when dispatch gates are closed, and does not burn
    // the retry budget: it's a verification, not an attempt).
    if (row.last_error?.startsWith(EXPIRED_OP_PREFIX)) {
      try {
        const operationId = await submitExistenceQueryToBridge(row.payload);
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'submitted',
                  qb_operation_id = ?,
                  payload = payload || ?::jsonb,
                  last_error = NULL,
                  next_retry_at = NULL,
                  updated_at = NOW()
            WHERE id = ?`,
          [
            operationId,
            JSON.stringify({ [EXISTENCE_CHECK_KEY]: true }),
            row.id,
          ]
        );
        logger.info(
          `${TAG} row ${row.id}: dispatched existence check for expired Add (op ${operationId})`
        );
      } catch (err: any) {
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET last_error = ?,
                  next_retry_at = NOW() + INTERVAL '${FIRST_ERROR_BACKOFF_MIN} minutes',
                  updated_at = NOW()
            WHERE id = ?`,
          [`${EXPIRED_OP_PREFIX} check dispatch failed: ${err.message}`, row.id]
        );
        logger.warn(
          `${TAG} row ${row.id}: existence-check dispatch failed: ${err.message}`
        );
      }
      continue;
    }

    // A blocked PO/fence must not burn the retry budget — defer without
    // counting it, otherwise the row exhausts its retries waiting on
    // something outside its control.
    const gate = await checkAllDispatchGates(knex, row.purchase_order_id);
    if (gate.blocked) {
      await holdRow(knex, row.id, gate.reason, "defer");
      held++;
      logger.warn(`${TAG} row ${row.id} retry held: ${gate.reason}`);
      continue;
    }

    const newRetries = (row.retries ?? 0) + 1;
    const exhausted = newRetries >= MAX_RETRIES;

    if (exhausted) {
      await knex.raw(
        `UPDATE qb_vendor_bill_pipeline
            SET status = 'failed_permanent',
                retries = ?,
                updated_at = NOW()
          WHERE id = ?`,
        [newRetries, row.id]
      );
      permaFailed++;
      logger.error(
        `${TAG} row ${row.id} failed_permanent after ${MAX_RETRIES} retries: ${row.last_error}`
      );
      continue;
    }

    try {
      const freshPayload = await refreshNullPoTxnLineIds(
        knex, logger, TAG, row.payload, row.id
      );
      const idempotencyKey = `vendor-bill:${row.vendor_bill_id}:g${row.rebuild_generation ?? 0}`;
      const operationId = await submitAddToBridge(freshPayload, idempotencyKey);
      await knex.raw(
        `UPDATE qb_vendor_bill_pipeline
            SET status = 'submitted',
                qb_operation_id = ?,
                retries = ?,
                last_error = NULL,
                next_retry_at = NULL,
                updated_at = NOW()
          WHERE id = ?`,
        [operationId, newRetries, row.id]
      );
      retried++;
    } catch (err: any) {
      const delay = backoffMs(newRetries);
      await knex.raw(
        `UPDATE qb_vendor_bill_pipeline
            SET retries = ?,
                last_error = ?,
                next_retry_at = NOW() + (? * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE id = ?`,
        [newRetries, err.message, delay, row.id]
      );
      logger.warn(
        `${TAG} retry ${newRetries}/${MAX_RETRIES} failed for row ${row.id}: ${err.message}`
      );
    }
  }

  // ── Phase D: Unlock — submit (preflight query or delete, by marker) ──────
  // Not flag-gated on `QB_VENDOR_BILL_MODE`: a row only reaches here via
  // `claimUnlock`, which already required the bill to be QB-synced, so an
  // unlock in flight must be allowed to drain even if the flag is off.
  const unlockSubmittable = (await knex
    .raw(
      `SELECT id, vendor_bill_id, purchase_order_id, qb_txn_id, payload, retries
         FROM qb_vendor_bill_pipeline
        WHERE intent = 'unlock_rebuild'
          AND status = 'waiting'
          AND qb_operation_id IS NULL
          AND deleted_at IS NULL
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r) => r.rows)) as Array<{
    id: string;
    vendor_bill_id: string;
    purchase_order_id: string | null;
    qb_txn_id: string | null;
    payload: Record<string, unknown>;
    retries: number | null;
  }>;

  if (unlockSubmittable.length > 0) {
    logger.info(`${TAG} phase D: submitting ${unlockSubmittable.length} unlock rows`);
  }

  for (const row of unlockSubmittable) {
    if (!row.qb_txn_id) {
      // claimUnlock only accepts already-synced bills, so this should never
      // happen — fail loud rather than silently spin.
      await knex.raw(
        `UPDATE qb_vendor_bill_pipeline
            SET status = 'failed_permanent',
                last_error = 'Unlock claimed but pipeline row has no qb_txn_id — cannot query/delete the QB Bill. Needs manual repair.',
                updated_at = NOW()
          WHERE id = ?`,
        [row.id]
      );
      unlockError++;
      logger.error(`${TAG} unlock row ${row.id}: no qb_txn_id — parked failed_permanent`);
      continue;
    }

    const isDeleteStep = row.payload?.[UNLOCK_DELETE_KEY] === true;
    try {
      if (isDeleteStep) {
        const operationId = await submitUnlockDeleteToBridge(row.qb_txn_id);
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET qb_operation_id = ?, status = 'submitted', updated_at = NOW()
            WHERE id = ?`,
          [operationId, row.id]
        );
      } else {
        const operationId = await submitUnlockPreflightQueryToBridge(row.qb_txn_id);
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET qb_operation_id = ?,
                  status = 'submitted',
                  payload = payload || ?::jsonb,
                  updated_at = NOW()
            WHERE id = ?`,
          [operationId, JSON.stringify({ [UNLOCK_PREFLIGHT_KEY]: true }), row.id]
        );
      }
      unlockSubmitted++;
    } catch (err: any) {
      const newRetries = (row.retries ?? 0) + 1;
      if (newRetries >= MAX_RETRIES) {
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'failed_permanent', retries = ?, last_error = ?, updated_at = NOW()
            WHERE id = ?`,
          [newRetries, err.message, row.id]
        );
        unlockError++;
        logger.error(
          `${TAG} unlock row ${row.id} failed_permanent after ${MAX_RETRIES} submit attempts: ${err.message}`
        );
      } else {
        const delay = backoffMs(newRetries);
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET retries = ?,
                  last_error = ?,
                  next_retry_at = NOW() + (? * INTERVAL '1 millisecond'),
                  updated_at = NOW()
            WHERE id = ?`,
          [newRetries, err.message, delay, row.id]
        );
        logger.warn(
          `${TAG} unlock row ${row.id} submit failed (attempt ${newRetries}/${MAX_RETRIES}): ${err.message}`
        );
      }
    }
  }

  // ── Phase D: Unlock — poll ────────────────────────────────────────────────
  const unlockPolling = (await knex
    .raw(
      `SELECT id, vendor_bill_id, purchase_order_id, qb_txn_id, payload, qb_operation_id, retries
         FROM qb_vendor_bill_pipeline
        WHERE intent = 'unlock_rebuild'
          AND status = 'submitted'
          AND qb_operation_id IS NOT NULL
          AND deleted_at IS NULL
        LIMIT ?`,
      [MAX_ROWS_PER_TICK]
    )
    .then((r) => r.rows)) as Array<{
    id: string;
    vendor_bill_id: string;
    purchase_order_id: string | null;
    qb_txn_id: string | null;
    payload: Record<string, unknown>;
    qb_operation_id: string;
    retries: number | null;
  }>;

  for (const row of unlockPolling) {
    try {
      const data = await pollBridge(row.qb_operation_id);
      const opStatus = data.operation?.status;
      if (!opStatus || opStatus === "queued" || opStatus === "processing") continue;

      const isPreflight = row.payload?.[UNLOCK_PREFLIGHT_KEY] === true;
      const isDeleteStep = row.payload?.[UNLOCK_DELETE_KEY] === true;

      // Shared retry-or-fail helper for both sub-steps: an op-level failure
      // (bridge/transport) never mutated QB, so it's always safe to hand the
      // SAME step back to Phase D submit — never escalate straight to abort.
      const retryOrFail = async (errMsg: string, failMsgPrefix: string) => {
        const newRetries = (row.retries ?? 0) + 1;
        if (newRetries >= MAX_RETRIES) {
          await knex.raw(
            `UPDATE qb_vendor_bill_pipeline
                SET status = 'failed_permanent',
                    qb_operation_id = NULL,
                    retries = ?,
                    last_error = ?,
                    updated_at = NOW()
              WHERE id = ?`,
            [newRetries, `${failMsgPrefix} after ${MAX_RETRIES} attempts: ${errMsg}`, row.id]
          );
          unlockError++;
        } else {
          const delay = backoffMs(newRetries);
          await knex.raw(
            `UPDATE qb_vendor_bill_pipeline
                SET status = 'waiting',
                    qb_operation_id = NULL,
                    retries = ?,
                    last_error = ?,
                    next_retry_at = NOW() + (? * INTERVAL '1 millisecond'),
                    updated_at = NOW()
              WHERE id = ?`,
            [newRetries, errMsg, delay, row.id]
          );
        }
      };

      if (isPreflight) {
        if (opStatus === "failed" || opStatus === "expired") {
          await retryOrFail(
            data.operation?.error ?? `Bridge preflight query ${opStatus}`,
            "Unlock preflight verification failed — QB Bill was never touched, still synced/locked"
          );
          continue;
        }

        const billRet = extractBillRetByTxnId(data, row.qb_txn_id ?? "");
        if (!billRet) {
          await retryOrFail(
            "Preflight BillQuery completed but returned no matching Bill for this TxnID",
            "Unlock preflight verification failed — QB Bill was never touched, still synced/locked"
          );
          continue;
        }

        if (isBillPaid(billRet)) {
          // ABORT — nothing in QB was ever touched, so reverting the row is
          // exactly restoring the pre-unlock state.
          await knex.raw(
            `UPDATE qb_vendor_bill_pipeline
                SET intent = 'add',
                    status = 'synced',
                    qb_operation_id = NULL,
                    payload = payload - ?,
                    retries = 0,
                    next_retry_at = NULL,
                    last_error = 'UNLOCK ABORTED: bill is paid in QuickBooks — unapply the payment first',
                    updated_at = NOW()
              WHERE id = ?`,
            [UNLOCK_PREFLIGHT_KEY, row.id]
          );
          unlockAborted++;
          logger.warn(
            `${TAG} unlock row ${row.id} aborted — bill ${row.qb_txn_id} is paid in QB`
          );
          continue;
        }

        // Unpaid — advance to the delete step.
        await knex.raw(
          `UPDATE qb_vendor_bill_pipeline
              SET status = 'waiting',
                  qb_operation_id = NULL,
                  payload = (payload - ?) || ?::jsonb,
                  updated_at = NOW()
            WHERE id = ?`,
          [UNLOCK_PREFLIGHT_KEY, JSON.stringify({ [UNLOCK_DELETE_KEY]: true }), row.id]
        );
        continue;
      }

      if (isDeleteStep) {
        if (opStatus === "failed" || opStatus === "expired") {
          await retryOrFail(
            data.operation?.error ?? `Bridge delete ${opStatus}`,
            "Unlock delete (TxnDel) failed — QB Bill likely still exists, needs manual review"
          );
          continue;
        }

        const { code, msg } = extractTxnDelStatus(data);
        if (code !== "0" && code !== "3120") {
          // A real QB rejection — nothing was deleted, bill stays locked
          // (safe direction: never leave the PO bill-less silently).
          await retryOrFail(
            `QuickBooks Error ${code}: ${msg}`,
            "QuickBooks rejected the unlock delete"
          );
          continue;
        }

        // statusCode 0 (deleted) or 3120 (already gone) — commit the unlock.
        try {
          await commitUnlockDelete(knex, logger, TAG, {
            id: row.id,
            vendor_bill_id: row.vendor_bill_id,
          });
          unlockCommitted++;
          logger.info(
            `${TAG} unlock committed for bill ${row.vendor_bill_id} — QB Bill ${row.qb_txn_id} deleted, will re-add`
          );
        } catch (commitErr: any) {
          // The transaction inside commitUnlockDelete rolled back on its own
          // failure, so the row is still 'submitted' with this same
          // (already-completed) op — the next tick re-derives the same
          // TxnDelRs and retries the commit idempotently.
          logger.error(
            `${TAG} unlock row ${row.id}: QB confirmed delete but the local commit failed — will retry next tick: ${commitErr.message}`
          );
        }
        continue;
      }

      // Neither marker present — an inconsistent row (should be unreachable
      // given Phase D submit always stamps one before dispatching). Park it
      // rather than loop forever.
      logger.warn(
        `${TAG} unlock row ${row.id}: submitted op with neither preflight nor delete marker — parking`
      );
      await knex.raw(
        `UPDATE qb_vendor_bill_pipeline
            SET status = 'failed_permanent',
                qb_operation_id = NULL,
                last_error = 'Unlock row in inconsistent state (no step marker) — needs manual repair',
                updated_at = NOW()
          WHERE id = ?`,
        [row.id]
      );
      unlockError++;
    } catch (err: any) {
      logger.warn(`${TAG} unlock poll failed for row ${row.id}: ${err.message}`);
    }
  }

  if (
    submitted || resolved || toError || retried || permaFailed || held ||
    unlockSubmitted || unlockAborted || unlockCommitted || unlockError
  ) {
    logger.info(
      `${TAG} tick: mode=${billModeEnabled ? "bill" : "item_receipt"} ` +
        `submitted=${submitted} resolved=${resolved} →error=${toError} ` +
        `retried=${retried} failed_permanent=${permaFailed} held=${held} ` +
        `unlockSubmitted=${unlockSubmitted} unlockAborted=${unlockAborted} ` +
        `unlockCommitted=${unlockCommitted} unlockError=${unlockError}`
    );
  }
}

export const config = {
  name: "qb-vendor-bill-poller",
  schedule: "*/1 * * * *",
};
