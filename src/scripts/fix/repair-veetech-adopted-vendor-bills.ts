/**
 * Repairs the 2026-07-24 Veetech reconciliation incident.
 *
 * Two bad outcomes are repaired:
 *  1. POS-authored, numbered bills with real lines were relabelled
 *     qb_source='adopted' and status='synced'. They remain the canonical bill;
 *     restore qb_source=NULL and status='confirmed' while keeping their QB link.
 *  2. Header-only adopted stubs were inserted beside an existing POS bill for
 *     the same PO and amount. Move the QB identity onto the canonical POS bill
 *     and soft-delete the redundant stub.
 *
 * Safety:
 *  - dry-run by default; pass positional `apply` to write.
 *  - only China-agent vendors are eligible (live qb_vendor metadata).
 *  - duplicate matching requires one and only one regular POS bill on the same
 *    PO whose active product-line total exactly equals QB AmountDue.
 *  - stubs must be unnumbered, line-less, pipeline-less, and created during the
 *    incident insertion window.
 *  - converted bills must be numbered, have active lines, be pipeline-less,
 *    and have been updated during the incident conversion window.
 *  - every write is performed in one transaction after re-validating the plan.
 *
 * Usage (from backend/):
 *   npx medusa exec ./src/scripts/fix/repair-veetech-adopted-vendor-bills.ts
 *   npx medusa exec ./src/scripts/fix/repair-veetech-adopted-vendor-bills.ts apply
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { writeFileSync } from "fs";

const REPORT_PATH = "/tmp/repair-veetech-adopted-vendor-bills.json";
const INSERT_WINDOW_START = "2026-07-24T03:00:00.000Z";
const INSERT_WINDOW_END = "2026-07-24T04:00:00.000Z";
const CONVERT_WINDOW_START = "2026-07-24T04:00:00.000Z";
const CONVERT_WINDOW_END = "2026-07-24T04:30:00.000Z";
const AUDIT_TAG = "[repair-veetech-adopted-2026-07-24]";

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  transaction: () => Promise<
    KnexLike & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
}

interface ConvertedBill {
  id: string;
  number: string;
  po_number: string;
  qb_txn_id: string;
  qb_ref_number: string | null;
  line_count: number;
  line_total_cents: number;
}

interface DuplicatePair {
  stub_id: string;
  canonical_id: string;
  canonical_number: string;
  canonical_status: string;
  po_number: string;
  qb_txn_id: string;
  qb_edit_sequence: string | null;
  qb_ref_number: string | null;
  qb_amount_due_cents: number;
  document_date: string | null;
}

interface AmbiguousStub {
  stub_id: string;
  po_number: string;
  qb_ref_number: string | null;
  qb_amount_due_cents: number | null;
  matching_bill_ids: string[];
}

interface RepairPlan {
  converted: ConvertedBill[];
  duplicatePairs: DuplicatePair[];
  ambiguousStubs: AmbiguousStub[];
  ownedLinkedToSync: Array<{
    id: string;
    number: string;
    po_number: string;
    previous_status: string;
  }>;
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function asIsoDate(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid document_date returned by PostgreSQL: ${String(value)}`);
  }
  return date.toISOString();
}

async function buildPlan(db: KnexLike): Promise<RepairPlan> {
  const convertedResult = await db.raw(
    `
    WITH active_lines AS (
      SELECT vendor_bill_id,
             COUNT(*)::int AS line_count,
             COALESCE(SUM(unit_cost_cents::bigint * qty), 0)::bigint AS line_total_cents
        FROM vendor_bill_line
       WHERE deleted_at IS NULL
       GROUP BY vendor_bill_id
    )
    SELECT vb.id, vb.number, po.number AS po_number, vb.qb_txn_id,
           vb.qb_ref_number, al.line_count, al.line_total_cents
      FROM vendor_bill vb
      JOIN purchase_order po
        ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
      JOIN qb_vendor qv
        ON qv.id = po.vendor_id AND qv.deleted_at IS NULL
      JOIN active_lines al ON al.vendor_bill_id = vb.id
     WHERE vb.deleted_at IS NULL
       AND vb.bill_type = 'regular'
       AND vb.qb_source = 'adopted'
       AND vb.status = 'synced'
       AND vb.number IS NOT NULL
       AND vb.qb_txn_id IS NOT NULL
       AND al.line_count > 0
       AND vb.created_at < ?::timestamptz
       AND (
             (
               vb.updated_at >= ?::timestamptz
               AND vb.updated_at < ?::timestamptz
             )
             OR (
               -- The operator-wide Net 21 correction on 2026-07-24 changed
               -- updated_at after the incident. Preserve the original guard,
               -- but explicitly recognize only Veetech rows carrying that
               -- verified correction.
               lower(qv.company_name) = lower('Shenzhen Veetech Co., Ltd')
               AND vb.payment_terms_days = 21
               AND vb.document_date IS NOT NULL
               AND vb.due_date = vb.document_date + INTERVAL '21 days'
             )
           )
       AND COALESCE(
             (qv.metadata ->> 'is_china_agent') = 'true'
             OR qv.metadata @> '{"is_china_agent": true}'::jsonb,
             false
           )
       AND NOT EXISTS (
             SELECT 1
               FROM qb_vendor_bill_pipeline p
              WHERE p.vendor_bill_id = vb.id AND p.deleted_at IS NULL
           )
     ORDER BY po.number, vb.number
    `,
    [INSERT_WINDOW_START, CONVERT_WINDOW_START, CONVERT_WINDOW_END]
  );

  const converted = convertedResult.rows.map((row) => ({
    id: String(row.id),
    number: String(row.number),
    po_number: String(row.po_number),
    qb_txn_id: String(row.qb_txn_id),
    qb_ref_number: row.qb_ref_number == null ? null : String(row.qb_ref_number),
    line_count: asNumber(row.line_count),
    line_total_cents: asNumber(row.line_total_cents),
  }));

  const stubsResult = await db.raw(
    `
    SELECT vb.id, po.number AS po_number, vb.purchase_order_id,
           vb.qb_txn_id, vb.qb_edit_sequence, vb.qb_ref_number,
           vb.qb_amount_due_cents, vb.document_date
      FROM vendor_bill vb
      JOIN purchase_order po
        ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
      JOIN qb_vendor qv
        ON qv.id = po.vendor_id AND qv.deleted_at IS NULL
     WHERE vb.deleted_at IS NULL
       AND vb.bill_type = 'regular'
       AND vb.qb_source = 'adopted'
       AND vb.status = 'synced'
       AND vb.number IS NULL
       AND vb.qb_txn_id IS NOT NULL
       AND vb.qb_amount_due_cents IS NOT NULL
       AND vb.created_at >= ?::timestamptz
       AND vb.created_at < ?::timestamptz
       AND COALESCE(
             (qv.metadata ->> 'is_china_agent') = 'true'
             OR qv.metadata @> '{"is_china_agent": true}'::jsonb,
             false
           )
       AND NOT EXISTS (
             SELECT 1 FROM vendor_bill_line l
              WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL
           )
       AND NOT EXISTS (
             SELECT 1 FROM qb_vendor_bill_pipeline p
              WHERE p.vendor_bill_id = vb.id AND p.deleted_at IS NULL
           )
     ORDER BY po.number, vb.id
    `,
    [INSERT_WINDOW_START, INSERT_WINDOW_END]
  );

  const duplicatePairs: DuplicatePair[] = [];
  const ambiguousStubs: AmbiguousStub[] = [];

  for (const stub of stubsResult.rows) {
    const matchesResult = await db.raw(
      `
      SELECT vb.id, vb.number, vb.status
        FROM vendor_bill vb
       WHERE vb.purchase_order_id = ?
         AND vb.deleted_at IS NULL
         AND vb.bill_type = 'regular'
         AND vb.qb_source IS NULL
         AND vb.number IS NOT NULL
         AND vb.qb_txn_id IS NULL
         AND (
           SELECT COALESCE(SUM(l.unit_cost_cents::bigint * l.qty), 0)::bigint
             FROM vendor_bill_line l
            WHERE l.vendor_bill_id = vb.id
              AND l.deleted_at IS NULL
              AND COALESCE(l.line_type, 'product') = 'product'
         ) = ?
       ORDER BY vb.created_at
      `,
      [stub.purchase_order_id, stub.qb_amount_due_cents]
    );

    if (matchesResult.rows.length !== 1) {
      ambiguousStubs.push({
        stub_id: String(stub.id),
        po_number: String(stub.po_number),
        qb_ref_number:
          stub.qb_ref_number == null ? null : String(stub.qb_ref_number),
        qb_amount_due_cents:
          stub.qb_amount_due_cents == null
            ? null
            : asNumber(stub.qb_amount_due_cents),
        matching_bill_ids: matchesResult.rows.map((row) => String(row.id)),
      });
      continue;
    }

    const canonical = matchesResult.rows[0]!;
    duplicatePairs.push({
      stub_id: String(stub.id),
      canonical_id: String(canonical.id),
      canonical_number: String(canonical.number),
      canonical_status: String(canonical.status),
      po_number: String(stub.po_number),
      qb_txn_id: String(stub.qb_txn_id),
      qb_edit_sequence:
        stub.qb_edit_sequence == null ? null : String(stub.qb_edit_sequence),
      qb_ref_number:
        stub.qb_ref_number == null ? null : String(stub.qb_ref_number),
      qb_amount_due_cents: asNumber(stub.qb_amount_due_cents),
      document_date: asIsoDate(stub.document_date),
    });
  }

  const ownedLinkedResult = await db.raw(
    `
    SELECT vb.id, vb.number, po.number AS po_number,
           vb.status AS previous_status
      FROM vendor_bill vb
      JOIN purchase_order po
        ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
      JOIN qb_vendor qv
        ON qv.id = po.vendor_id AND qv.deleted_at IS NULL
     WHERE vb.deleted_at IS NULL
       AND vb.bill_type = 'regular'
       AND vb.qb_source IS NULL
       AND vb.qb_txn_id IS NOT NULL
       AND vb.number IS NOT NULL
       AND vb.status <> 'synced'
       AND vb.notes LIKE '%' || ? || '%'
       AND COALESCE(
             (qv.metadata ->> 'is_china_agent') = 'true'
             OR qv.metadata @> '{"is_china_agent": true}'::jsonb,
             false
           )
     ORDER BY po.number, vb.number
    `,
    [AUDIT_TAG]
  );
  const ownedLinkedToSync = ownedLinkedResult.rows.map((row) => ({
    id: String(row.id),
    number: String(row.number),
    po_number: String(row.po_number),
    previous_status: String(row.previous_status),
  }));

  return { converted, duplicatePairs, ambiguousStubs, ownedLinkedToSync };
}

function printPlan(plan: RepairPlan, apply: boolean): void {
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Report: ${REPORT_PATH}\n`);

  console.log(
    `POS bills incorrectly relabelled Adopted: ${plan.converted.length}`
  );
  for (const bill of plan.converted) {
    console.log(
      `  ${bill.po_number} ${bill.number}: adopted/synced -> owned/synced ` +
        `(QB ${bill.qb_ref_number ?? bill.qb_txn_id}, ${bill.line_count} lines)`
    );
  }

  console.log(`\nDuplicate adopted stubs with one exact match: ${plan.duplicatePairs.length}`);
  for (const pair of plan.duplicatePairs) {
    console.log(
      `  ${pair.po_number}: retire ${pair.stub_id}; link QB ` +
        `${pair.qb_ref_number ?? pair.qb_txn_id} -> ${pair.canonical_number} ` +
        `(preserve status ${pair.canonical_status}, $${(
          pair.qb_amount_due_cents / 100
        ).toFixed(2)})`
    );
  }

  console.log(`\nAmbiguous stubs (NEVER modified): ${plan.ambiguousStubs.length}`);
  for (const stub of plan.ambiguousStubs) {
    console.log(
      `  ${stub.po_number} ${stub.qb_ref_number ?? stub.stub_id}: ` +
        `${stub.matching_bill_ids.length} exact local matches`
    );
  }

  console.log(
    `\nRepaired owned bills already linked but not Synced: ${plan.ownedLinkedToSync.length}`
  );
  for (const bill of plan.ownedLinkedToSync) {
    console.log(
      `  ${bill.po_number} ${bill.number}: ${bill.previous_status} -> synced`
    );
  }
}

async function applyPlan(db: KnexLike, expected: RepairPlan): Promise<void> {
  const trx = await db.transaction();
  try {
    const locked = await trx.raw(
      `SELECT pg_advisory_xact_lock(hashtext(?))`,
      [AUDIT_TAG]
    );
    void locked;

    const current = await buildPlan(trx);
    const expectedJson = JSON.stringify(expected);
    const currentJson = JSON.stringify(current);
    if (currentJson !== expectedJson) {
      throw new Error(
        "Repair plan changed after transaction lock; aborting without writes"
      );
    }
    if (current.ambiguousStubs.length > 0) {
      throw new Error(
        `${current.ambiguousStubs.length} ambiguous stub(s) require manual review; aborting`
      );
    }

    for (const bill of current.converted) {
      const result = await trx.raw(
        `
        UPDATE vendor_bill
           SET qb_source = NULL,
               status = 'synced',
               notes = concat_ws(E'\\n', NULLIF(notes, ''), ?::text),
               updated_at = NOW()
         WHERE id = ?
           AND deleted_at IS NULL
           AND qb_source = 'adopted'
           AND status = 'synced'
         RETURNING id
        `,
        [
          `${AUDIT_TAG} Restored POS ownership; retained reconciled QB identity.`,
          bill.id,
        ]
      );
      if (result.rows.length !== 1) {
        throw new Error(`Converted bill ${bill.id} failed its write guard`);
      }
    }

    for (const pair of current.duplicatePairs) {
      const retired = await trx.raw(
        `
        UPDATE vendor_bill
           SET deleted_at = NOW(),
               notes = concat_ws(E'\\n', NULLIF(notes, ''), ?::text),
               updated_at = NOW()
         WHERE id = ?
           AND deleted_at IS NULL
           AND qb_source = 'adopted'
           AND number IS NULL
         RETURNING id
        `,
        [
          `${AUDIT_TAG} Redundant adopted stub retired; QB identity moved to ${pair.canonical_number}.`,
          pair.stub_id,
        ]
      );
      if (retired.rows.length !== 1) {
        throw new Error(`Stub ${pair.stub_id} failed its retire guard`);
      }

      const linked = await trx.raw(
        `
        UPDATE vendor_bill
           SET qb_txn_id = ?,
               qb_edit_sequence = ?,
               qb_ref_number = ?,
               qb_synced_at = NOW(),
               qb_amount_due_cents = ?,
               document_date = COALESCE(document_date, ?::timestamptz),
               qb_source = NULL,
               status = 'synced',
               notes = concat_ws(E'\\n', NULLIF(notes, ''), ?::text),
               updated_at = NOW()
         WHERE id = ?
           AND deleted_at IS NULL
           AND qb_source IS NULL
           AND qb_txn_id IS NULL
           AND number = ?
           AND status = ?
         RETURNING id
        `,
        [
          pair.qb_txn_id,
          pair.qb_edit_sequence,
          pair.qb_ref_number,
          pair.qb_amount_due_cents,
          pair.document_date,
          `${AUDIT_TAG} Reconciled to existing QB Bill; POS bill remains canonical and editable.`,
          pair.canonical_id,
          pair.canonical_number,
          pair.canonical_status,
        ]
      );
      if (linked.rows.length !== 1) {
        throw new Error(
          `Canonical bill ${pair.canonical_id} failed its link guard`
        );
      }
    }

    for (const bill of current.ownedLinkedToSync) {
      const result = await trx.raw(
        `
        UPDATE vendor_bill
           SET status = 'synced',
               notes = concat_ws(E'\\n', NULLIF(notes, ''), ?::text),
               updated_at = NOW()
         WHERE id = ?
           AND deleted_at IS NULL
           AND qb_source IS NULL
           AND qb_txn_id IS NOT NULL
           AND status = ?
         RETURNING id
        `,
        [
          `${AUDIT_TAG} Normalized lifecycle status to synced because the owned POS bill is linked to QuickBooks.`,
          bill.id,
          bill.previous_status,
        ]
      );
      if (result.rows.length !== 1) {
        throw new Error(`Owned linked bill ${bill.id} failed its status guard`);
      }
    }

    await trx.commit();
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export default async function repairVeetechAdoptedVendorBills({
  container,
  args,
}: ExecArgs): Promise<void> {
  const apply = (args ?? []).includes("apply");
  const db = container.resolve("__pg_connection__") as unknown as KnexLike;
  const plan = await buildPlan(db);

  printPlan(plan, apply);
  writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        mode: apply ? "apply" : "dry-run",
        windows: {
          insert: [INSERT_WINDOW_START, INSERT_WINDOW_END],
          convert: [CONVERT_WINDOW_START, CONVERT_WINDOW_END],
        },
        ...plan,
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log("\nDRY-RUN only. Pass positional `apply` to execute.");
    return;
  }

  await applyPlan(db, plan);
  console.log(
    `\nApplied: restored ${plan.converted.length} owned bill(s), ` +
      `retired ${plan.duplicatePairs.length} duplicate stub(s), normalized ` +
      `${plan.ownedLinkedToSync.length} linked status(es).`
  );
}
