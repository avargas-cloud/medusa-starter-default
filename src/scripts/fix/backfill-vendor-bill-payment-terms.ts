/**
 * Backfills Vendor Bill payment terms and due dates from each QB vendor.
 *
 * Sources:
 * - qb_vendor.metadata.default_payment_terms_days, populated by the QB vendor
 *   + Terms sync.
 * - ELA Florida has no TermsRef in QB. Its existing QB Bill FTL - 1573151 has
 *   TxnDate 2026-07-22 and DueDate 2026-08-01, so its local default is an
 *   evidence-backed 10 days.
 *
 * Dry-run by default:
 *   npx medusa exec ./src/scripts/fix/backfill-vendor-bill-payment-terms.ts
 * Apply:
 *   npx medusa exec ./src/scripts/fix/backfill-vendor-bill-payment-terms.ts apply
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { writeFileSync } from "fs";

const REPORT_PATH = "/tmp/backfill-vendor-bill-payment-terms.json";
const ELA_QB_LIST_ID = "80002137-1749680348";

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  transaction: () => Promise<
    KnexLike & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
}

type PlannedBill = {
  id: string;
  number: string | null;
  reference_id: string | null;
  vendor_name: string;
  terms_days: number;
  source: "vendor_default" | "qb_bill_due_date_inference";
  document_date: string;
  due_date: string;
};

async function buildPlan(db: KnexLike): Promise<PlannedBill[]> {
  const result = await db.raw(
    `SELECT vb.id, vb.number, vb.reference_id,
            COALESCE(qv.company_name, qv.full_name, qv.name, qv.id) AS vendor_name,
            CASE
              WHEN qv.qb_list_id = ? THEN 10
              ELSE (qv.metadata->>'default_payment_terms_days')::int
            END AS terms_days,
            CASE
              WHEN qv.qb_list_id = ? THEN 'qb_bill_due_date_inference'
              ELSE 'vendor_default'
            END AS source,
            vb.document_date,
            vb.document_date + make_interval(days =>
              CASE
                WHEN qv.qb_list_id = ? THEN 10
                ELSE (qv.metadata->>'default_payment_terms_days')::int
              END
            ) AS due_date
       FROM vendor_bill vb
       JOIN qb_vendor qv
         ON qv.id = vb.vendor_id AND qv.deleted_at IS NULL
      WHERE vb.deleted_at IS NULL
        AND vb.document_date IS NOT NULL
        AND (
          qv.qb_list_id = ?
          OR (qv.metadata->>'default_payment_terms_days') ~ '^[0-9]+$'
        )
      ORDER BY vendor_name, vb.document_date, vb.id`,
    [ELA_QB_LIST_ID, ELA_QB_LIST_ID, ELA_QB_LIST_ID, ELA_QB_LIST_ID]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    number: row.number == null ? null : String(row.number),
    reference_id: row.reference_id == null ? null : String(row.reference_id),
    vendor_name: String(row.vendor_name),
    terms_days: Number(row.terms_days),
    source: String(row.source) as PlannedBill["source"],
    document_date: new Date(String(row.document_date)).toISOString(),
    due_date: new Date(String(row.due_date)).toISOString(),
  }));
}

export default async function backfillVendorBillPaymentTerms({
  container,
}: ExecArgs) {
  const db = container.resolve("__pg_connection__") as KnexLike;
  const apply = process.argv.includes("apply");
  const plan = await buildPlan(db);
  const activeCountResult = await db.raw(
    `SELECT COUNT(*)::int AS count
       FROM vendor_bill
      WHERE deleted_at IS NULL`
  );
  const activeCount = Number(activeCountResult.rows[0]?.count ?? 0);

  const byVendor = Object.entries(
    plan.reduce<Record<string, { bills: number; days: number; source: string }>>(
      (acc, bill) => {
        const current = acc[bill.vendor_name];
        acc[bill.vendor_name] = {
          bills: (current?.bills ?? 0) + 1,
          days: bill.terms_days,
          source: bill.source,
        };
        return acc;
      },
      {}
    )
  ).map(([vendor, data]) => ({ vendor, ...data }));

  const report = {
    mode: apply ? "apply" : "dry-run",
    active_bills: activeCount,
    planned_bills: plan.length,
    skipped_bills: activeCount - plan.length,
    vendors: byVendor,
    bills: plan,
  };
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, bills: undefined }, null, 2));
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) return;
  if (plan.length !== activeCount) {
    throw new Error(
      `Refusing partial apply: planned ${plan.length} of ${activeCount} active bills`
    );
  }

  const trx = await db.transaction();
  try {
    await trx.raw(
      `UPDATE qb_vendor
          SET metadata = COALESCE(metadata, '{}'::jsonb) ||
                '{"default_payment_terms_days":10,"default_payment_terms_days_manual":true,"payment_terms":"Net 10"}'::jsonb,
              updated_at = NOW()
        WHERE qb_list_id = ? AND deleted_at IS NULL`,
      [ELA_QB_LIST_ID]
    );
    const ids = plan.map((bill) => bill.id);
    const updateResult = await trx.raw(
      `UPDATE vendor_bill vb
          SET payment_terms_days = CASE
                WHEN qv.qb_list_id = ? THEN 10
                ELSE (qv.metadata->>'default_payment_terms_days')::int
              END,
              due_date = vb.document_date + make_interval(days =>
                CASE
                  WHEN qv.qb_list_id = ? THEN 10
                  ELSE (qv.metadata->>'default_payment_terms_days')::int
                END
              ),
              updated_at = NOW()
         FROM qb_vendor qv
        WHERE vb.vendor_id = qv.id
          AND vb.id = ANY(?)
          AND vb.deleted_at IS NULL`,
      [ELA_QB_LIST_ID, ELA_QB_LIST_ID, ids]
    );
    if (Number(updateResult.rowCount ?? 0) !== plan.length) {
      throw new Error(
        `Expected ${plan.length} updates, got ${updateResult.rowCount ?? 0}`
      );
    }
    await trx.commit();
  } catch (error) {
    await trx.rollback();
    throw error;
  }

  console.log(`Applied payment terms to ${plan.length} Vendor Bills.`);
}
