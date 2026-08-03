/**
 * src/api/admin/purchase-orders/_lib/tracking-writes.ts
 *
 * Every write to a PO's inbound shipments, done transactionally.
 *
 * WHY A LOCK
 * Two of the rules here are properties of a SET of rows, so no database
 * constraint can hold them:
 *   - the cap: a line's allocations across sibling shipments may not exceed
 *     what was ordered;
 *   - mutual exclusion: a PO is EITHER one whole-PO shipment OR broken out per
 *     item, never both and never two whole-PO ones.
 * That leaves a read-then-write, and a read-then-write without a lock is
 * exactly how a PO ends up with 120% of a line in transit: two editors both
 * read 60 remaining and both write 60. `pg_advisory_xact_lock` on the PO id
 * serializes them per PO — narrow enough that two POs never wait on each other.
 *
 * The checks run INSIDE the same transaction that inserts, so the world a
 * request validated against is the world it writes into.
 *
 * IDs are generated here rather than by the model layer so the whole write can
 * be one raw transaction — mixing the module service and a raw transaction
 * would put the insert outside the lock, which defeats the point.
 */

import {
  resolveAllocatablePoLines,
  validateAllocations,
  TRACKING_SCOPE_ALL_ORDER,
  TRACKING_SCOPE_BY_LINE,
  type AllocationRejection,
  type RequestedAllocation,
} from "../../../../lib/purchase-orders/po-tracking-allocations";

export type TrackingKnex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction: <T>(fn: (trx: TrackingKnex) => Promise<T>) => Promise<T>;
};

/** A carrier number as it arrives from the client. */
export interface NumberInput {
  provider: string;
  tracking_number: string;
  tracking_url: string;
  manual_eta: string | null;
}

export interface EditableNumberInput extends NumberInput {
  id: string;
}

export interface ShipmentWriteInput {
  /** At least one. The FIRST is the master. */
  numbers: NumberInput[];
  /** Empty means "the whole PO travels in this shipment". */
  lines: RequestedAllocation[];
}

export interface ScopeConflict {
  /** Master tracking numbers of the shipments standing in the way. */
  blocking: string[];
  /**
   * `whole_po_exists` — a whole-PO shipment already claims everything.
   * `already_split`   — the PO is already broken out per item.
   */
  reason: "whole_po_exists" | "already_split";
}

export interface TrackingWriteResult {
  ok: boolean;
  shipment_id?: string;
  /** Populated when ok === false because a quantity exceeded the remainder. */
  rejections?: AllocationRejection[];
  /** Populated when ok === false because the write would contradict a sibling. */
  scopeConflict?: ScopeConflict;
  /** Populated when ok === false because a carrier number is already on the PO. */
  duplicateNumber?: string;
  /** The edit payload did not name exactly the shipment's existing numbers. */
  invalidNumberSet?: boolean;
}

/**
 * A purchase order is EITHER covered by one whole-PO shipment OR broken out
 * per item. Never both, and never two of the former.
 *
 * `all_order` is not "we don't know what's in the box" — it is the claim
 * "everything on this PO travels in this delivery". Two deliveries making that
 * claim contradict each other exactly as much as a whole-PO delivery sitting
 * beside a per-item one: in both cases some unit is spoken for twice.
 *
 * Note this is about DELIVERIES, not tracking numbers. Two waybills for the
 * same truck are two numbers on ONE shipment and are perfectly fine — that
 * distinction is the whole reason numbers live in their own table.
 *
 * So the resulting state must be one of:
 *   - exactly one `all_order` shipment and no `by_line`, or
 *   - zero `all_order` and any number of `by_line`.
 *
 * The way to split a PO is therefore to EDIT the whole-PO shipment and mark
 * what actually arrived in it. That converts it to `by_line` and frees the
 * units left unmarked for the next delivery. Splitting is a correction of the
 * first delivery, never an addition beside it.
 *
 * Validated on the RESULTING state, not on the incoming payload — which is what
 * lets the edit path be the way out while every add path stays closed.
 *
 * LEGACY IS TOLERATED ON READ, NOT ON WRITE. `verify-po-tracking-allocations.ts`
 * lists any PO that still holds a forbidden combination, so the backlog is
 * visible rather than silent.
 */
async function scopeConflictAfterWrite(
  trx: TrackingKnex,
  purchaseOrderId: string,
  writingScope: string,
  excludeShipmentId: string | null
): Promise<ScopeConflict | null> {
  const result = await trx.raw(
    `SELECT trk.scope,
            COALESCE(
              (SELECT n.tracking_number
                 FROM purchase_order_tracking_number n
                WHERE n.purchase_order_tracking_id = trk.id
                  AND n.deleted_at IS NULL
                ORDER BY n.is_master DESC, n.created_at, n.id
                LIMIT 1),
              trk.id
            ) AS label
       FROM purchase_order_tracking trk
      WHERE trk.purchase_order_id = ?
        AND trk.deleted_at IS NULL
        AND (?::text IS NULL OR trk.id <> ?::text)
      ORDER BY trk.created_at, trk.id`,
    [purchaseOrderId, excludeShipmentId, excludeShipmentId]
  );
  const others = result.rows as Array<{ scope: string; label: string }>;

  // A whole-PO delivery claims everything, so it tolerates NO sibling at all —
  // not a per-item one (mixing) and not another whole-PO one (double claim).
  const conflicting =
    writingScope === TRACKING_SCOPE_ALL_ORDER
      ? others
      : others.filter((o) => o.scope === TRACKING_SCOPE_ALL_ORDER);

  if (conflicting.length === 0) return null;

  return {
    blocking: conflicting.map((o) => o.label),
    reason: conflicting.some((o) => o.scope === TRACKING_SCOPE_ALL_ORDER)
      ? "whole_po_exists"
      : "already_split",
  };
}

function newId(prefix: string, salt = ""): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}${salt}`;
}

/** Scope is derived from the payload, never trusted from the client. */
function scopeFor(lines: RequestedAllocation[]): string {
  return lines.length > 0 ? TRACKING_SCOPE_BY_LINE : TRACKING_SCOPE_ALL_ORDER;
}

/**
 * A carrier number may name only one delivery on a PO.
 *
 * Without this, the same waybill could sit on two shipments of the same order
 * and its ETA would be attributed to both — the per-line date would silently
 * count one truck twice.
 */
async function duplicateNumberOnPo(
  trx: TrackingKnex,
  purchaseOrderId: string,
  numbers: NumberInput[],
  excludeShipmentId: string | null
): Promise<string | null> {
  if (numbers.length === 0) return null;
  const result = await trx.raw(
    `SELECT n.tracking_number
       FROM purchase_order_tracking_number n
      WHERE n.purchase_order_id = ?
        AND n.deleted_at IS NULL
        AND (?::text IS NULL OR n.purchase_order_tracking_id <> ?::text)
        AND n.tracking_number = ANY(?)
      LIMIT 1`,
    [
      purchaseOrderId,
      excludeShipmentId,
      excludeShipmentId,
      numbers.map((n) => n.tracking_number),
    ]
  );
  const row = result.rows[0] as { tracking_number: string } | undefined;
  return row?.tracking_number ?? null;
}

async function writeNumbers(
  trx: TrackingKnex,
  shipmentId: string,
  purchaseOrderId: string,
  numbers: NumberInput[],
  userId: string | null
): Promise<void> {
  for (const [i, n] of numbers.entries()) {
    await trx.raw(
      `INSERT INTO purchase_order_tracking_number
         (id, purchase_order_tracking_id, purchase_order_id, provider,
          tracking_number, tracking_url, is_master, carrier_eta, manual_eta, carrier_status,
          carrier_eta_fetched_at, carrier_detail, created_by_user_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', NULL, NULL, ?, now(), now())`,
      [
        newId("potrkn", String(i)),
        shipmentId,
        purchaseOrderId,
        n.provider,
        n.tracking_number,
        n.tracking_url,
        i === 0, // the first number is the master
        n.manual_eta,
        userId,
      ]
    );
  }
}

async function writeAllocations(
  trx: TrackingKnex,
  shipmentId: string,
  purchaseOrderId: string,
  lines: RequestedAllocation[]
): Promise<void> {
  for (const [i, line] of lines.entries()) {
    await trx.raw(
      `INSERT INTO purchase_order_tracking_line
         (id, purchase_order_tracking_id, purchase_order_line_id,
          purchase_order_id, qty_allocated, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, now(), now())`,
      [
        newId("potrkl", String(i)),
        shipmentId,
        line.purchase_order_line_id,
        purchaseOrderId,
        line.qty,
      ]
    );
  }
}

/** Add a new inbound delivery to a PO, with its numbers and allocations. */
export async function createShipment(
  db: TrackingKnex,
  purchaseOrderId: string,
  input: ShipmentWriteInput,
  userId: string | null
): Promise<TrackingWriteResult> {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
      `po_tracking_${purchaseOrderId}`,
    ]);

    const scope = scopeFor(input.lines);
    const conflict = await scopeConflictAfterWrite(
      trx,
      purchaseOrderId,
      scope,
      null
    );
    if (conflict) return { ok: false, scopeConflict: conflict };

    const dup = await duplicateNumberOnPo(
      trx,
      purchaseOrderId,
      input.numbers,
      null
    );
    if (dup) return { ok: false, duplicateNumber: dup };

    const available = await resolveAllocatablePoLines(trx, purchaseOrderId);
    const rejections = validateAllocations(input.lines, available);
    if (rejections.length > 0) return { ok: false, rejections };

    const shipmentId = newId("potrk");
    await trx.raw(
      `INSERT INTO purchase_order_tracking
         (id, purchase_order_id, scope, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, now(), now())`,
      [shipmentId, purchaseOrderId, scope, userId]
    );

    await writeNumbers(trx, shipmentId, purchaseOrderId, input.numbers, userId);
    await writeAllocations(trx, shipmentId, purchaseOrderId, input.lines);
    return { ok: true, shipment_id: shipmentId };
  });
}

/**
 * Attach another carrier number to a delivery already on record.
 *
 * This is the answer to "the same truck produced a second waybill": the goods
 * were already declared, only the label is new. Nothing about scope or
 * quantities changes, so none of those checks apply — which is exactly why this
 * is a separate operation instead of an edit that resubmits everything.
 */
export async function addNumberToShipment(
  db: TrackingKnex,
  purchaseOrderId: string,
  shipmentId: string,
  number: NumberInput,
  userId: string | null
): Promise<TrackingWriteResult> {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
      `po_tracking_${purchaseOrderId}`,
    ]);

    const dup = await duplicateNumberOnPo(trx, purchaseOrderId, [number], null);
    if (dup) return { ok: false, duplicateNumber: dup };

    await trx.raw(
      `INSERT INTO purchase_order_tracking_number
         (id, purchase_order_tracking_id, purchase_order_id, provider,
          tracking_number, tracking_url, is_master, carrier_eta, manual_eta, carrier_status,
          carrier_eta_fetched_at, carrier_detail, created_by_user_id,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, false, NULL, ?, 'pending', NULL, NULL, ?, now(), now())`,
      [
        newId("potrkn"),
        shipmentId,
        purchaseOrderId,
        number.provider,
        number.tracking_number,
        number.tracking_url,
        number.manual_eta,
        userId,
      ]
    );

    return { ok: true, shipment_id: shipmentId };
  });
}

/**
 * Remove one carrier number from a delivery.
 *
 * Removing the master promotes the oldest survivor rather than leaving the
 * shipment nameless — a delivery with no master has nothing to quote on a
 * document. Removing the LAST number is refused: that is a request to delete
 * the delivery, and deleting it is a different, explicit action with different
 * consequences (it frees the allocated quantity).
 */
export async function removeNumberFromShipment(
  db: TrackingKnex,
  purchaseOrderId: string,
  numberId: string
): Promise<{ ok: boolean; lastNumber?: boolean }> {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
      `po_tracking_${purchaseOrderId}`,
    ]);

    const found = (
      await trx.raw(
        `SELECT purchase_order_tracking_id AS shipment_id, is_master
           FROM purchase_order_tracking_number
          WHERE id = ? AND deleted_at IS NULL`,
        [numberId]
      )
    ).rows[0] as { shipment_id: string; is_master: boolean } | undefined;
    if (!found) return { ok: false };

    const siblings = (
      await trx.raw(
        `SELECT count(*)::int AS n
           FROM purchase_order_tracking_number
          WHERE purchase_order_tracking_id = ? AND deleted_at IS NULL`,
        [found.shipment_id]
      )
    ).rows[0] as { n: number };
    if (Number(siblings.n) <= 1) return { ok: false, lastNumber: true };

    await trx.raw(`DELETE FROM purchase_order_tracking_number WHERE id = ?`, [
      numberId,
    ]);

    if (found.is_master) {
      await trx.raw(
        `UPDATE purchase_order_tracking_number
            SET is_master = true, updated_at = now()
          WHERE id = (
                SELECT id FROM purchase_order_tracking_number
                 WHERE purchase_order_tracking_id = ? AND deleted_at IS NULL
                 ORDER BY created_at, id LIMIT 1)`,
        [found.shipment_id]
      );
    }

    return { ok: true };
  });
}

/**
 * Replace a delivery's allocation set — the operation that splits a PO.
 *
 * Allocations are replaced wholesale rather than diffed: the editor always
 * submits the complete set, and a diff would have to guess whether an absent
 * line means "removed" or "not sent". The shipment's own units are excluded
 * from the sibling sum, so re-saving what it already holds is never rejected.
 */
export async function updateShipment(
  db: TrackingKnex,
  purchaseOrderId: string,
  shipmentId: string,
  lines: RequestedAllocation[],
  numbers: EditableNumberInput[] | undefined,
  userId: string | null
): Promise<TrackingWriteResult> {
  return db.transaction(async (trx) => {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
      `po_tracking_${purchaseOrderId}`,
    ]);

    // Converting THIS delivery is how a PO gets split, so it is excluded from
    // the conflict check — what matters is whether its siblings still disagree.
    const scope = scopeFor(lines);
    const conflict = await scopeConflictAfterWrite(
      trx,
      purchaseOrderId,
      scope,
      shipmentId
    );
    if (conflict) return { ok: false, scopeConflict: conflict };

    const available = await resolveAllocatablePoLines(
      trx,
      purchaseOrderId,
      shipmentId
    );
    const rejections = validateAllocations(lines, available);
    if (rejections.length > 0) return { ok: false, rejections };

    if (numbers) {
      const current = (
        await trx.raw(
          `SELECT id
             FROM purchase_order_tracking_number
            WHERE purchase_order_tracking_id = ?
              AND purchase_order_id = ?
              AND deleted_at IS NULL
            ORDER BY created_at, id
            FOR UPDATE`,
          [shipmentId, purchaseOrderId]
        )
      ).rows as Array<{ id: string }>;
      const submittedIds = new Set(numbers.map((number) => number.id));
      if (
        current.length !== numbers.length ||
        current.some((number) => !submittedIds.has(number.id))
      ) {
        return { ok: false, invalidNumberSet: true };
      }

      const duplicateInPayload = numbers.find(
        (number, index) =>
          numbers.findIndex(
            (candidate) => candidate.tracking_number === number.tracking_number
          ) !== index
      );
      if (duplicateInPayload) {
        return {
          ok: false,
          duplicateNumber: duplicateInPayload.tracking_number,
        };
      }

      const duplicate = await duplicateNumberOnPo(
        trx,
        purchaseOrderId,
        numbers,
        shipmentId
      );
      if (duplicate) return { ok: false, duplicateNumber: duplicate };
    }

    await trx.raw(
      `UPDATE purchase_order_tracking
          SET scope = ?, updated_by_user_id = ?, updated_at = now()
        WHERE id = ? AND deleted_at IS NULL`,
      [scope, userId, shipmentId]
    );

    for (const number of numbers ?? []) {
      await trx.raw(
        `UPDATE purchase_order_tracking_number
            SET provider = ?,
                tracking_number = ?,
                tracking_url = ?,
                manual_eta = ?,
                carrier_eta = CASE
                  WHEN provider <> ? OR tracking_number <> ? THEN NULL
                  ELSE carrier_eta
                END,
                carrier_status = CASE
                  WHEN provider <> ? OR tracking_number <> ? THEN 'pending'
                  ELSE carrier_status
                END,
                carrier_eta_fetched_at = CASE
                  WHEN provider <> ? OR tracking_number <> ? THEN NULL
                  ELSE carrier_eta_fetched_at
                END,
                carrier_detail = CASE
                  WHEN provider <> ? OR tracking_number <> ? THEN NULL
                  ELSE carrier_detail
                END,
                updated_at = now()
          WHERE id = ?
            AND purchase_order_tracking_id = ?
            AND purchase_order_id = ?
            AND deleted_at IS NULL`,
        [
          number.provider,
          number.tracking_number,
          number.tracking_url,
          number.manual_eta,
          number.provider,
          number.tracking_number,
          number.provider,
          number.tracking_number,
          number.provider,
          number.tracking_number,
          number.provider,
          number.tracking_number,
          number.id,
          shipmentId,
          purchaseOrderId,
        ]
      );
    }

    await trx.raw(
      `DELETE FROM purchase_order_tracking_line
        WHERE purchase_order_tracking_id = ?`,
      [shipmentId]
    );
    await writeAllocations(trx, shipmentId, purchaseOrderId, lines);

    return { ok: true, shipment_id: shipmentId };
  });
}

/**
 * Remove a delivery. Its numbers and allocations go with it via ON DELETE
 * CASCADE, which is what frees the quantity for the next one.
 */
export async function deleteShipment(
  db: TrackingKnex,
  purchaseOrderId: string,
  shipmentId: string
): Promise<void> {
  await db.transaction(async (trx) => {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [
      `po_tracking_${purchaseOrderId}`,
    ]);
    await trx.raw(`DELETE FROM purchase_order_tracking WHERE id = ?`, [
      shipmentId,
    ]);
  });
}
