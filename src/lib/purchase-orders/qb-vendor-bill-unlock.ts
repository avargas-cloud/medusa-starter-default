/**
 * src/lib/purchase-orders/qb-vendor-bill-unlock.ts
 *
 * Phase 1 (item 1.9, `docs/VENDOR_BILL_QB_SYNC_PLAN.md` §6.2/§9 — SIMPLIFIED
 * MVP, Fable design decision 2026-07-23): claims a synced vendor bill for
 * "Unlock" — the guard/audit logic shared by the HTTP route
 * (`api/admin/vendor-bills/[id]/qb-unlock/route.ts`) and its verify script.
 *
 * Unlock itself is delete-then-re-add BEHIND THE EXISTING DISPATCH GATES:
 * this function only *claims* the pipeline row (flips it to
 * `intent='unlock_rebuild'`, `status='waiting'`) after checking the three
 * hard guards. The actual `TxnDel Bill` + BillQuery preflight + re-`BillAdd`
 * lifecycle lives in `qb-vendor-bill-poller.ts` Phase D.
 *
 * Guards (in order):
 *   1. Bill must exist, be a REGULAR bill, and already be synced to QB
 *      (`qb_txn_id` set) — nothing to unlock otherwise.
 *   2. China-agent bills are out of scope (D4) — modifications go through
 *      the Phase 2 split-bill flow instead. Read LIVE off `qb_vendor`
 *      (2026-07-06 rule: never trust a snapshot for this flag).
 *   3. A pipeline row already mid-unlock (`intent='unlock_rebuild'`) or
 *      mid-void (`void_status` non-terminal) is a 409, not a second claim —
 *      unlock and void both delete the same QB Bill and must never race.
 *
 * The claim itself is UPDATE-first / INSERT-fallback (2026-07-15 rule: a
 * one-row-per-bill pipeline table never blind-INSERTs). `snapshot` gets the
 * pre-unlock payload + the audit trail (reason/actor/timestamp) — the bill's
 * own `payload` column is left untouched here; the poller's re-BillAdd
 * refreshes it from live bill lines after the delete confirms.
 */

export type UnlockKnex = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
};

export type ClaimUnlockResult =
  | { ok: true; pipelineRowId: string }
  | { ok: false; code: "bill_not_found"; message: string }
  | { ok: false; code: "bill_not_synced"; message: string }
  | { ok: false; code: "china_agent_unlock_blocked"; message: string }
  | { ok: false; code: "unlock_already_in_flight"; message: string };

export interface ClaimUnlockInput {
  reason: string;
  actorId: string;
}

interface BillRow {
  id: string;
  purchase_order_id: string | null;
  qb_txn_id: string | null;
  status: string;
  bill_type: string;
}

interface PipelineRow {
  id: string;
  intent: string;
  void_status: string | null;
}

// `void_status` values that mean "nothing in flight" — anything else
// (waiting/processing/error) is an active void that must finish first.
const TERMINAL_VOID_STATUSES = new Set<string | null>([null, "voided", "failed_permanent"]);

export async function claimUnlock(
  knex: UnlockKnex,
  vendorBillId: string,
  input: ClaimUnlockInput
): Promise<ClaimUnlockResult> {
  const billResult = await knex.raw(
    `SELECT id, purchase_order_id, qb_txn_id, status, bill_type
       FROM vendor_bill
      WHERE id = ? AND deleted_at IS NULL AND bill_type = 'regular'`,
    [vendorBillId]
  );
  const bill = (billResult.rows[0] ?? null) as BillRow | null;
  if (!bill) {
    return {
      ok: false,
      code: "bill_not_found",
      message: "Vendor bill not found or not a regular bill",
    };
  }
  if (!bill.qb_txn_id) {
    return {
      ok: false,
      code: "bill_not_synced",
      message: "This bill has not synced to QuickBooks yet — nothing to unlock",
    };
  }

  // Guard 2 — China-agent fence (D4), same LIVE-read pattern as
  // qb-vendor-bill-enqueue.ts's Phase-2 scope fence.
  if (bill.purchase_order_id) {
    const agentResult = await knex.raw(
      `SELECT 1
         FROM qb_vendor qv
         JOIN purchase_order po ON po.vendor_id = qv.id AND po.deleted_at IS NULL
        WHERE po.id = ? AND qv.deleted_at IS NULL
          AND COALESCE((qv.metadata ->> 'is_china_agent') = 'true'
                       OR qv.metadata @> '{"is_china_agent": true}'::jsonb, false)`,
      [bill.purchase_order_id]
    );
    if (agentResult.rows.length > 0) {
      return {
        ok: false,
        code: "china_agent_unlock_blocked",
        message:
          "China-agent bills cannot be unlocked here — modifications go " +
          "through the China split-bill flow (Phase 2).",
      };
    }
  }

  // Guard 3 — no other unlock/void already in flight for this bill's row.
  const existing = await knex.raw(
    `SELECT id, intent, void_status
       FROM qb_vendor_bill_pipeline
      WHERE vendor_bill_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [vendorBillId]
  );
  const row = (existing.rows[0] ?? null) as PipelineRow | null;
  if (row) {
    if (row.intent === "unlock_rebuild") {
      return {
        ok: false,
        code: "unlock_already_in_flight",
        message: "An unlock is already in progress for this bill",
      };
    }
    if (!TERMINAL_VOID_STATUSES.has(row.void_status)) {
      return {
        ok: false,
        code: "unlock_already_in_flight",
        message: `A void operation is already in progress for this bill (void_status=${row.void_status})`,
      };
    }
  }

  // Claim: UPDATE-first (2026-07-15 rule). `snapshot` audits the pre-unlock
  // payload + who/why/when; `payload` itself is left as-is — the re-BillAdd
  // (poller Phase D commit) refreshes it from live bill lines.
  const updateResult = await knex.raw(
    `UPDATE qb_vendor_bill_pipeline
        SET intent = 'unlock_rebuild',
            status = 'waiting',
            qb_operation_id = NULL,
            last_error = NULL,
            next_retry_at = NULL,
            retries = 0,
            qb_txn_id = COALESCE(qb_txn_id, ?),
            snapshot = jsonb_build_object(
              'previous_payload', payload,
              'unlock_reason', ?::text,
              'unlocked_by', ?::text,
              'unlocked_at', NOW()
            ),
            updated_at = NOW()
      WHERE vendor_bill_id = ? AND deleted_at IS NULL
      RETURNING id`,
    [bill.qb_txn_id, input.reason, input.actorId, vendorBillId]
  );
  const updatedRow = updateResult.rows[0] as { id: string } | undefined;
  if (updatedRow) return { ok: true, pipelineRowId: updatedRow.id };

  // No pipeline row exists yet — can happen for a bill adopted via the
  // reconciliation script (plan §10), which writes `vendor_bill` directly
  // without a pipeline row. INSERT-fallback so unlock still works for it.
  const insertResult = await knex.raw(
    `INSERT INTO qb_vendor_bill_pipeline
       (id, vendor_bill_id, purchase_order_id, status, intent, qb_txn_id,
        payload, snapshot, created_at, updated_at)
     VALUES (?, ?, ?, 'waiting', 'unlock_rebuild', ?, '{}'::jsonb,
             jsonb_build_object(
               'previous_payload', '{}'::jsonb,
               'unlock_reason', ?::text,
               'unlocked_by', ?::text,
               'unlocked_at', NOW()
             ),
             NOW(), NOW())
     RETURNING id`,
    [
      `qbvbpipe_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
      vendorBillId,
      bill.purchase_order_id,
      bill.qb_txn_id,
      input.reason,
      input.actorId,
    ]
  );
  const inserted = insertResult.rows[0] as { id: string };
  return { ok: true, pipelineRowId: inserted.id };
}
