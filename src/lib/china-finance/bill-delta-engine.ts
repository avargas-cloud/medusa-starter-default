/**
 * China Finance — bill split "delta engine" (F2).
 *
 * Single source of truth for changing a bill's TOTAL owed amount when that bill
 * may be split into "Partial #N" child rows. Called by every amount-change path
 * (manual edit, vendor_bill auto-sync, reassign) so the split/collapse rules live
 * in ONE transactional place.
 *
 * Model (see docs/CHINA_FINANCE_SPLIT_BILL_PLAN.md):
 *   - A split group = rows sharing `split_group_id` (= the root/anchor id). The
 *     root has `partial_seq = 1` and keeps `vendor_bill_id`. Siblings have
 *     seq 2..k and `vendor_bill_id = NULL`.
 *   - `bill.amount_cents` (of each child) = the schedulable partial liability.
 *   - `application.applied_cents` = what a wire actually paid. For draft/unassigned
 *     partials `applied == amount`; a CONFIRMED partial may have `applied > amount`
 *     (overpay credit — applied is immutable).
 *   - Invariant: Σ child.amount_cents == the bill's true total.
 *
 * Reglas implementadas (increase → last partial; decrease → cascade; collapse):
 *   1/2 increase, last partial unassigned/draft → grow it (+ its draft wire).
 *   3   increase, last partial confirmed          → new unassigned Partial #k+1.
 *   4   decrease, draft/unassigned                 → shrink last, cascade back,
 *                                                     delete emptied non-root rows.
 *   5   decrease, confirmed                        → reduce amount only (app stays
 *                                                     → credit); never delete.
 *   7   collapse                                   → when one row remains, drop the
 *                                                     split labels (un-split).
 *
 * The caller MUST run this inside a transaction and should hold the appropriate
 * locks; the engine additionally FOR UPDATEs the affected bill rows + wires.
 */

import { randomUUID } from "crypto";

export type DeltaSource = "manual_edit" | "vendor_sync" | "reassign_split";

export interface PgConn {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface BillDeltaResult {
  rootBillId: string;
  previousTotalCents: number;
  newTotalCents: number;
  createdPartialIds: string[];
  deletedPartialIds: string[];
  affectedWireIds: string[];
  collapsedToUnsplit: boolean;
  source: DeltaSource;
}

interface MemberRow {
  id: string;
  amount_cents: number;
  partial_seq: number | null;
  split_group_id: string | null;
  type: string | null;
  document_type: string;
  sort_order: number;
  invoice_number: string | null;
  po_number: string | null;
  po_ref_number: string | null;
  payee: string | null;
  description: string | null;
  document_date: string | null;
  due_date: string | null;
  app_id: string | null;
  applied_cents: number | null;
  wire_id: string | null;
  wire_status: "draft" | "confirmed" | null;
  isRoot: boolean;
}

async function rows<T>(db: PgConn, sql: string, bindings?: unknown[]): Promise<T[]> {
  const r = await db.raw(sql, bindings);
  return r.rows as T[];
}

async function loadGroup(db: PgConn, groupId: string): Promise<MemberRow[]> {
  const raw = await rows<Omit<MemberRow, "isRoot">>(
    db,
    `SELECT b.id, b.amount_cents, b.partial_seq, b.split_group_id, b.type,
            b.document_type, b.sort_order, b.invoice_number, b.po_number,
            b.po_ref_number, b.payee, b.description,
            b.document_date::text AS document_date, b.due_date::text AS due_date,
            a.id AS app_id, a.applied_cents, a.wire_transfer_id AS wire_id,
            w.status AS wire_status
       FROM china_finance_bill b
       LEFT JOIN china_wire_transfer_application a ON a.bill_id = b.id
       LEFT JOIN china_wire_transfer w ON w.id = a.wire_transfer_id
      WHERE b.split_group_id = ? OR (b.id = ? AND b.split_group_id IS NULL)
      ORDER BY b.partial_seq ASC NULLS FIRST, b.sort_order ASC
      FOR UPDATE OF b`,
    [groupId, groupId]
  );
  return raw.map((m) => ({ ...m, isRoot: m.id === groupId }));
}

async function lockWire(db: PgConn, wireId: string): Promise<void> {
  await db.raw(`SELECT id FROM china_wire_transfer WHERE id = ? FOR UPDATE`, [wireId]);
}

async function setAmount(db: PgConn, billId: string, amount: number): Promise<void> {
  await db.raw(
    `UPDATE china_finance_bill SET amount_cents = ?, updated_at = now() WHERE id = ?`,
    [amount, billId]
  );
}

async function bumpWire(db: PgConn, wireId: string, deltaCents: number): Promise<void> {
  await lockWire(db, wireId);
  await db.raw(
    `UPDATE china_wire_transfer
        SET wire_amount_cents = wire_amount_cents + ?, updated_at = now()
      WHERE id = ?`,
    [deltaCents, wireId]
  );
}

async function setApplied(db: PgConn, appId: string, applied: number): Promise<void> {
  await db.raw(
    `UPDATE china_wire_transfer_application SET applied_cents = ?, updated_at = now() WHERE id = ?`,
    [applied, appId]
  );
}

async function deleteApp(db: PgConn, appId: string): Promise<void> {
  await db.raw(`DELETE FROM china_wire_transfer_application WHERE id = ?`, [appId]);
}

async function deleteBill(db: PgConn, billId: string): Promise<void> {
  await db.raw(`DELETE FROM china_finance_bill WHERE id = ?`, [billId]);
}

async function promoteToSplit(db: PgConn, billId: string): Promise<void> {
  await db.raw(
    `UPDATE china_finance_bill SET split_group_id = id, partial_seq = 1, updated_at = now() WHERE id = ?`,
    [billId]
  );
}

async function insertPartial(
  db: PgConn,
  root: MemberRow,
  groupId: string,
  amount: number,
  seq: number
): Promise<string> {
  const id = randomUUID();
  await db.raw(
    `INSERT INTO china_finance_bill
       (id, type, sort_order, vendor_bill_id, wire_transfer_id, document_type,
        invoice_number, po_number, po_ref_number, payee, description,
        amount_cents, document_date, due_date, split_group_id, partial_seq, split_version)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, root.type, root.sort_order, root.document_type, root.invoice_number,
     root.po_number, root.po_ref_number, root.payee, root.description, amount,
     root.document_date, root.due_date, groupId, seq]
  );
  return id;
}

export async function applyBillTotalChange(
  db: PgConn,
  input: { billId: string; targetTotalCents: number; source: DeltaSource }
): Promise<BillDeltaResult> {
  const { billId, targetTotalCents, source } = input;
  if (!Number.isInteger(targetTotalCents) || targetTotalCents < 0) {
    throw new Error(`applyBillTotalChange: invalid targetTotalCents ${targetTotalCents}`);
  }

  // Resolve the group WITHOUT a row lock first (locking the anchor before the
  // group can deadlock two concurrent root/child edits). Then take a per-group
  // advisory lock so all edits to a group serialize deterministically, and only
  // after that lock the rows.
  const anchor = (
    await rows<{ id: string; split_group_id: string | null; type: string | null; document_type: string }>(
      db,
      `SELECT id, split_group_id, type, document_type FROM china_finance_bill WHERE id = ?`,
      [billId]
    )
  )[0];
  if (!anchor) throw new Error(`applyBillTotalChange: bill ${billId} not found`);
  if (anchor.type === "bank_fee" || anchor.document_type === "opening_balance") {
    throw new Error(`applyBillTotalChange: ${anchor.type}/${anchor.document_type} bills are not editable`);
  }

  const groupId = anchor.split_group_id ?? anchor.id;
  await db.raw(`SELECT pg_advisory_xact_lock(hashtext('cf_group:' || ?))`, [groupId]);
  let members = await loadGroup(db, groupId);
  if (members.length === 0) throw new Error(`applyBillTotalChange: group ${groupId} empty`);

  // Invariant guards — the engine requires the post-backfill shape (one
  // application per row; draft/unassigned partials have applied == amount). If
  // the data still holds a pre-backfill multi-application or partial-draft bill,
  // REFUSE rather than corrupt money (run the backfill / F3 split first).
  // Status-independent guard: one application per row (post-backfill shape).
  const ids = members.map((m) => m.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`applyBillTotalChange: bill in group ${groupId} still has >1 application — run split backfill first`);
  }

  // Lock every wire the group touches (deterministic id order), capturing the
  // FRESH status from the locked row. FOR UPDATE OF cannot target the nullable
  // side of a LEFT JOIN, so this is a separate pass. This both blocks a
  // concurrent confirm AND lets us reason on the current status — never on the
  // stale `wire_status` read during loadGroup (a confirm could have committed
  // between that read and this lock).
  const wireIds = Array.from(
    new Set(members.map((m) => m.wire_id).filter((x): x is string => !!x))
  ).sort();
  const freshStatus = new Map<string, "draft" | "confirmed">();
  for (const w of wireIds) {
    const r = await rows<{ id: string; status: "draft" | "confirmed" }>(
      db, `SELECT id, status FROM china_wire_transfer WHERE id = ? FOR UPDATE`, [w]
    );
    if (r[0]) freshStatus.set(w, r[0].status);
  }
  for (const m of members) {
    if (m.wire_id) m.wire_status = freshStatus.get(m.wire_id) ?? m.wire_status;
  }

  // Now enforce the partial-draft guard against the FRESH status: a wire that
  // just confirmed legitimately has applied != amount (overpay credit) and must
  // not trip this guard.
  for (const m of members) {
    if (m.wire_status === "draft" && m.applied_cents !== m.amount_cents) {
      throw new Error(`applyBillTotalChange: draft partial ${m.id} has applied ${m.applied_cents} != amount ${m.amount_cents} — split it (F3) first`);
    }
  }

  const wasSplit = members.some((m) => m.split_group_id !== null);
  const previousTotalCents = members.reduce((n, m) => n + m.amount_cents, 0);
  const delta = targetTotalCents - previousTotalCents;

  const result: BillDeltaResult = {
    rootBillId: groupId,
    previousTotalCents,
    newTotalCents: targetTotalCents,
    createdPartialIds: [],
    deletedPartialIds: [],
    affectedWireIds: [],
    collapsedToUnsplit: false,
    source,
  };
  if (delta === 0) return result;

  const root = members.find((m) => m.isRoot) ?? members[0];
  if (!root) throw new Error(`applyBillTotalChange: no root for ${groupId}`);
  const touchWire = (id: string | null) => { if (id) result.affectedWireIds.push(id); };

  if (delta > 0) {
    const last = members[members.length - 1];
    if (!last) throw new Error(`applyBillTotalChange: no last partial for ${groupId}`);
    if (!last.wire_status) {
      await setAmount(db, last.id, last.amount_cents + delta);
    } else if (last.wire_status === "draft") {
      await setAmount(db, last.id, last.amount_cents + delta);
      await setApplied(db, last.app_id!, (last.applied_cents ?? 0) + delta);
      await bumpWire(db, last.wire_id!, delta);
      touchWire(last.wire_id);
    } else {
      // last is confirmed → cannot grow a settled payment; spawn a new partial.
      if (members.length === 1 && root.split_group_id === null) {
        await promoteToSplit(db, groupId);
      }
      const maxSeq = members.reduce((n, m) => Math.max(n, m.partial_seq ?? 1), 1);
      const newId = await insertPartial(db, root, groupId, delta, maxSeq + 1);
      result.createdPartialIds.push(newId);
    }
  } else {
    // decrease: cascade from the highest seq downward.
    let remaining = -delta;
    for (let i = members.length - 1; i >= 0 && remaining > 0; i--) {
      const m = members[i];
      if (!m) continue;
      const take = Math.min(m.amount_cents, remaining);
      const newAmt = m.amount_cents - take;
      if (!m.wire_status) {
        if (newAmt === 0 && !m.isRoot) {
          await deleteBill(db, m.id);
          result.deletedPartialIds.push(m.id);
        } else {
          await setAmount(db, m.id, newAmt);
        }
      } else if (m.wire_status === "draft") {
        await bumpWire(db, m.wire_id!, -take);
        touchWire(m.wire_id);
        if (newAmt === 0) {
          await deleteApp(db, m.app_id!);
          if (!m.isRoot) {
            await deleteBill(db, m.id);
            result.deletedPartialIds.push(m.id);
          } else {
            await setAmount(db, m.id, 0);
          }
        } else {
          await setAmount(db, m.id, newAmt);
          await setApplied(db, m.app_id!, (m.applied_cents ?? 0) - take);
        }
      } else {
        // confirmed: reduce liability only; applied stays → overpay credit.
        await setAmount(db, m.id, newAmt);
      }
      remaining -= take;
    }
    if (remaining > 0) {
      throw new Error(`applyBillTotalChange: could not absorb decrease for ${groupId} (${remaining}¢ left)`);
    }
  }

  // Normalize: drop emptied non-root rows with no application, then collapse a
  // single-row group back to an un-split bill.
  await db.raw(
    `DELETE FROM china_finance_bill b
      WHERE b.split_group_id = ? AND b.id <> ? AND b.amount_cents = 0
        AND NOT EXISTS (SELECT 1 FROM china_wire_transfer_application a WHERE a.bill_id = b.id)`,
    [groupId, groupId]
  );
  // Collapse ONLY a group that was split and now has exactly one labelled row
  // left (count of split_group_id = groupId). An unsplit edit has count 0 → never
  // "collapses".
  const remainingCount = Number(
    (await rows<{ c: string }>(db, `SELECT COUNT(*)::bigint AS c FROM china_finance_bill WHERE split_group_id = ?`, [groupId]))[0]?.c ?? "0"
  );
  if (wasSplit && remainingCount === 1) {
    const collapsed = await rows<{ id: string }>(
      db,
      `UPDATE china_finance_bill SET split_group_id = NULL, partial_seq = NULL, updated_at = now()
        WHERE id = ? AND split_group_id IS NOT NULL RETURNING id`,
      [groupId]
    );
    result.collapsedToUnsplit = collapsed.length > 0;
  }

  // Bump the optimistic-lock version on all surviving group rows (incl. a
  // just-collapsed root, whose split_group_id is now NULL).
  await db.raw(
    `UPDATE china_finance_bill SET split_version = split_version + 1, updated_at = now()
      WHERE split_group_id = ? OR id = ?`,
    [groupId, groupId]
  );

  // Recompute the true total from the DB for the caller's sanity check.
  members = await loadGroup(db, groupId);
  result.newTotalCents = members.reduce((n, m) => n + m.amount_cents, 0);
  result.affectedWireIds = Array.from(new Set(result.affectedWireIds));
  return result;
}
