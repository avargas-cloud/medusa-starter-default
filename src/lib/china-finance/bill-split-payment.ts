/**
 * China Finance — Rule 6: split a bill for a PARTIAL payment.
 *
 * When staff decide to pay only part of a bill on a DRAFT wire, the bill becomes
 * "Partial #1" (the amount paid, staying on the wire) and a new unassigned
 * "Partial #(k+1)" record is created for the deferred remainder — schedulable on
 * a future wire. Total is preserved: Partial#1 + remainder == the bill's amount.
 *
 * The wire amount itself is NOT touched here — the Manage Drafts modal owns the
 * wire total (it auto-tracks Σ paid, or a manual override).
 */

import { randomUUID } from "crypto";
import type { PgConn } from "./bill-delta-engine";

export interface SplitResult {
  rootBillId: string;
  paidPartialId: string;
  remainderPartialId: string;
  remainderCents: number;
}

async function q<T>(db: PgConn, sql: string, bindings?: unknown[]): Promise<T[]> {
  return (await db.raw(sql, bindings)).rows as T[];
}

interface BillMeta {
  id: string;
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
  split_group_id: string | null;
}

export async function splitBillForPartialPayment(
  db: PgConn,
  input: { billId: string; payNowCents: number }
): Promise<SplitResult> {
  const { billId, payNowCents } = input;

  const bill = (
    await q<BillMeta>(
      db,
      `SELECT id, type, document_type, sort_order, invoice_number, po_number,
              po_ref_number, payee, description, document_date::text AS document_date,
              due_date::text AS due_date, split_group_id
         FROM china_finance_bill WHERE id = ?`,
      [billId]
    )
  )[0];
  if (!bill) throw new Error(`split: bill ${billId} not found`);
  if (bill.type === "bank_fee" || bill.document_type === "opening_balance") {
    throw new Error(`split: ${bill.type}/${bill.document_type} bills are not splittable`);
  }

  const groupId = bill.split_group_id ?? bill.id;
  await db.raw(`SELECT pg_advisory_xact_lock(hashtext('cf_group:' || ?))`, [groupId]);

  // Re-read the amount + the bill's DRAFT application under lock. The bill must
  // be sitting on a draft wire (that's what "pay part now" means), and the draft
  // one specifically: a bill may now hold more than one application — a bill
  // paid short keeps its confirmed one and gets a second for the remainder — so
  // joining the table plainly would return several rows and `[0]` would pick
  // whichever the plan produced.
  const locked = (
    await q<{ amount_cents: number; app_id: string | null; wire_id: string | null }>(
      db,
      `SELECT b.amount_cents, a.app_id, a.wire_id
         FROM china_finance_bill b
         LEFT JOIN LATERAL (
           SELECT app.id AS app_id, app.wire_transfer_id AS wire_id
             FROM china_wire_transfer_application app
             JOIN china_wire_transfer w ON w.id = app.wire_transfer_id
            WHERE app.bill_id = b.id AND w.status = 'draft'
            LIMIT 1
         ) a ON TRUE
        WHERE b.id = ? FOR UPDATE OF b`,
      [billId]
    )
  )[0];
  if (!locked) throw new Error(`split: bill ${billId} vanished`);
  if (!locked.app_id) {
    throw new Error(`split: bill ${billId} must be on a draft wire to split a partial payment`);
  }
  if (!Number.isInteger(payNowCents) || payNowCents < 1 || payNowCents >= locked.amount_cents) {
    throw new Error(`split: pay_now_cents ${payNowCents} must be between 1 and ${locked.amount_cents - 1}`);
  }
  if (locked.wire_id) {
    await db.raw(`SELECT id FROM china_wire_transfer WHERE id = ? FOR UPDATE`, [locked.wire_id]);
  }

  const remainder = locked.amount_cents - payNowCents;

  // Partial #1 = this bill, reduced to what's paid now (promote to a split group
  // if it wasn't one). Its draft application follows to the same amount.
  await db.raw(
    `UPDATE china_finance_bill
        SET amount_cents = ?, split_group_id = COALESCE(split_group_id, id),
            partial_seq = COALESCE(partial_seq, 1), split_version = split_version + 1,
            updated_at = now()
      WHERE id = ?`,
    [payNowCents, billId]
  );
  await db.raw(
    `UPDATE china_wire_transfer_application SET applied_cents = ?, updated_at = now() WHERE id = ?`,
    [payNowCents, locked.app_id]
  );

  // Partial #(k+1) = the deferred remainder, unassigned.
  const maxSeq = Number(
    (await q<{ m: string }>(db, `SELECT COALESCE(MAX(partial_seq), 1)::bigint AS m FROM china_finance_bill WHERE split_group_id = ?`, [groupId]))[0]?.m ?? "1"
  );
  const remId = randomUUID();
  await db.raw(
    `INSERT INTO china_finance_bill
       (id, type, sort_order, vendor_bill_id, wire_transfer_id, document_type,
        invoice_number, po_number, po_ref_number, payee, description, amount_cents,
        document_date, due_date, split_group_id, partial_seq, split_version)
     VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [remId, bill.type, bill.sort_order, bill.document_type, bill.invoice_number,
     bill.po_number, bill.po_ref_number, bill.payee, bill.description, remainder,
     bill.document_date, bill.due_date, groupId, maxSeq + 1]
  );

  return { rootBillId: groupId, paidPartialId: billId, remainderPartialId: remId, remainderCents: remainder };
}

export interface MergeResult {
  rootBillId: string;
  mergedIntoId: string;
  deletedPartialIds: string[];
  collapsedToUnsplit: boolean;
  newAmountCents: number;
}

/**
 * Rule 7 (reverse of split): raise a partial to absorb its deferred siblings.
 * The extra is pulled from the UNASSIGNED remainder partials (highest seq first),
 * which are deleted as they empty; if one row remains the group collapses back to
 * an un-split bill. Remainders already scheduled on another wire must be
 * unassigned first (this refuses to silently disturb another wire).
 */
export async function mergePartialToAmount(
  db: PgConn,
  input: { billId: string; newAmountCents: number }
): Promise<MergeResult> {
  const { billId, newAmountCents } = input;

  const target = (
    await q<{ split_group_id: string | null; type: string | null; document_type: string }>(
      db,
      `SELECT split_group_id, type, document_type FROM china_finance_bill WHERE id = ?`,
      [billId]
    )
  )[0];
  if (!target) throw new Error(`merge: bill ${billId} not found`);
  if (target.type === "bank_fee" || target.document_type === "opening_balance") {
    throw new Error(`merge: ${target.type}/${target.document_type} bills are not mergeable`);
  }
  const groupId = target.split_group_id ?? billId;
  await db.raw(`SELECT pg_advisory_xact_lock(hashtext('cf_group:' || ?))`, [groupId]);

  // ONE row per partial, whatever its applications. Two different questions are
  // asked of them below and they need different answers, so both come back:
  //
  //   has_app      — is this partial spoken for AT ALL? A donor must be
  //                  unassigned; treating a partial that carries a CONFIRMED
  //                  application as unassigned would let the loop below delete
  //                  or shrink money already wired.
  //   draft_app_id — the row to follow when the target's amount changes.
  //
  // Plainly joining the applications table would also fan `members` out to one
  // row per application, and `groupTotal` sums `amount_cents` over it — a
  // partial with two applications would have counted its amount twice.
  const members = await q<{ id: string; amount_cents: number; partial_seq: number | null; has_app: boolean; draft_app_id: string | null }>(
    db,
    `SELECT b.id, b.amount_cents, b.partial_seq, a.has_app, a.draft_app_id
       FROM china_finance_bill b
       LEFT JOIN LATERAL (
         SELECT EXISTS (
                  SELECT 1 FROM china_wire_transfer_application app
                   WHERE app.bill_id = b.id
                ) AS has_app,
                (SELECT app.id
                   FROM china_wire_transfer_application app
                   JOIN china_wire_transfer w ON w.id = app.wire_transfer_id
                  WHERE app.bill_id = b.id AND w.status = 'draft'
                  LIMIT 1) AS draft_app_id
       ) a ON TRUE
      WHERE b.split_group_id = ? ORDER BY b.partial_seq ASC FOR UPDATE OF b`,
    [groupId]
  );
  const tgt = members.find((m) => m.id === billId);
  if (!tgt) throw new Error(`merge: bill ${billId} is not part of split group ${groupId}`);
  const groupTotal = members.reduce((n, m) => n + m.amount_cents, 0);
  if (!Number.isInteger(newAmountCents) || newAmountCents <= tgt.amount_cents || newAmountCents > groupTotal) {
    throw new Error(`merge: new_amount_cents ${newAmountCents} must be > ${tgt.amount_cents} and <= group total ${groupTotal}`);
  }

  let extra = newAmountCents - tgt.amount_cents;
  const deletedPartialIds: string[] = [];
  // Donors = UNASSIGNED siblings, but NEVER the root (it anchors vendor_bill_id /
  // identity and must survive as the collapse target). Highest seq first.
  const donors = members
    .filter((m) => m.id !== billId && !m.has_app && m.id !== groupId)
    .sort((a, b) => (b.partial_seq ?? 0) - (a.partial_seq ?? 0));
  for (const d of donors) {
    if (extra <= 0) break;
    const take = Math.min(d.amount_cents, extra);
    if (take === d.amount_cents) {
      await db.raw(`DELETE FROM china_finance_bill WHERE id = ?`, [d.id]);
      deletedPartialIds.push(d.id);
    } else {
      await db.raw(`UPDATE china_finance_bill SET amount_cents = ?, updated_at = now() WHERE id = ?`, [d.amount_cents - take, d.id]);
    }
    extra -= take;
  }
  if (extra > 0) {
    throw new Error(`merge: cannot absorb ${extra}¢ — the remainder is on another wire or held by the root; raise the root partial instead`);
  }

  await db.raw(`UPDATE china_finance_bill SET amount_cents = ?, updated_at = now() WHERE id = ?`, [newAmountCents, billId]);
  if (tgt.draft_app_id) {
    await db.raw(`UPDATE china_wire_transfer_application SET applied_cents = ?, updated_at = now() WHERE id = ?`, [newAmountCents, tgt.draft_app_id]);
  }

  const remaining = Number(
    (await q<{ c: string }>(db, `SELECT COUNT(*)::bigint AS c FROM china_finance_bill WHERE split_group_id = ?`, [groupId]))[0]?.c ?? "0"
  );
  let collapsedToUnsplit = false;
  if (remaining === 1) {
    await db.raw(`UPDATE china_finance_bill SET split_group_id = NULL, partial_seq = NULL, updated_at = now() WHERE split_group_id = ?`, [groupId]);
    collapsedToUnsplit = true;
  }
  await db.raw(`UPDATE china_finance_bill SET split_version = split_version + 1, updated_at = now() WHERE split_group_id = ? OR id = ?`, [groupId, groupId]);

  return { rootBillId: groupId, mergedIntoId: billId, deletedPartialIds, collapsedToUnsplit, newAmountCents };
}
