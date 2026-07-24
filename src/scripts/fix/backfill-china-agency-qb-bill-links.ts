/**
 * Deep reconciliation for POS-owned China-agency Vendor Bills.
 *
 * QuickBooks is queried read-only. The script:
 *  - refreshes each Regular Bill header identity and EditSequence;
 *  - maps every POS product line to its QB Bill ItemLineRet TxnLineID;
 *  - stores Regular Bill negative clearing Expense lines;
 *  - links the associated Service/Freight/Tariff POS bills to their QB Bills;
 *  - maps component expense lines to their QB TxnLineIDs;
 *  - marks every fully reconciled POS bill as owned + synced.
 *
 * Matching is deliberately strict. Apply aborts unless every target group is
 * complete and unambiguous. Dry-run is the default.
 *
 * Usage (from backend/):
 *   DATABASE_URL=... yarn medusa exec \
 *     ./src/scripts/fix/backfill-china-agency-qb-bill-links.ts
 *   DATABASE_URL=... yarn medusa exec \
 *     ./src/scripts/fix/backfill-china-agency-qb-bill-links.ts apply
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { writeFileSync } from "fs";

import {
  queryVendorBills,
  type QbBill,
  type QbBillExpenseLine,
  type QbBillItemLine,
} from "../../api/admin/quickbooks/bill-match/_lib/bill-query";

const REPORT_PATH = "/tmp/backfill-china-agency-qb-bill-links.json";
const AUDIT_TAG = "[china-agency-qb-link-backfill-2026-07-24]";

interface KnexLike {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  transaction: () => Promise<
    KnexLike & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
}

type BillType = "regular" | "service" | "freight" | "tariff";

interface TargetBill {
  id: string;
  number: string;
  bill_type: BillType;
  reference_id: string;
  document_date: string;
  vendor_qb_list_id: string;
  qb_txn_id: string | null;
  total_cents: number;
}

interface RegularTarget extends TargetBill {
  bill_type: "regular";
  service_vendor_bill_id: string | null;
  freight_vendor_bill_id: string | null;
  tariff_vendor_bill_id: string | null;
}

interface LocalLine {
  id: string;
  qb_item_list_id: string | null;
  account_list_id: string | null;
  qty: number;
  amount_cents: number;
}

interface LineLink {
  local_line_id: string;
  qb_txn_line_id: string;
  qb_account_list_id?: string;
}

interface ClearingLine {
  kind: "freight" | "commission" | "tariff" | "other";
  account_list_id: string;
  account_full_name: string;
  amount_cents: number;
  qb_txn_line_id: string;
}

interface BillLinkPlan {
  local_bill_id: string;
  local_number: string;
  bill_type: BillType;
  qb_txn_id: string;
  qb_edit_sequence: string;
  qb_ref_number: string;
  qb_amount_due_cents: number;
  line_links: LineLink[];
  clearing_lines: ClearingLine[] | null;
}

interface GroupPlan {
  regular_id: string;
  regular_number: string;
  links: BillLinkPlan[];
  errors: string[];
}

interface BackfillPlan {
  query: { vendor_list_id: string; from_date: string; to_date: string };
  qb_bill_count: number;
  groups: GroupPlan[];
  errors: string[];
}

function asString(value: unknown): string {
  return value == null ? "" : String(value);
}

function asNumber(value: unknown): number {
  return Number(value ?? 0);
}

function dateOnly(value: unknown): string {
  const date = value instanceof Date ? value : new Date(asString(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${asString(value)}`);
  }
  return date.toISOString().slice(0, 10);
}

function previousDay(ymd: string): string {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function nextDay(ymd: string): string {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function classifyClearing(accountName: string): ClearingLine["kind"] {
  const normalized = accountName.toLowerCase();
  if (normalized.includes("commission")) return "commission";
  if (normalized.includes("duties") || normalized.includes("tariff")) {
    return "tariff";
  }
  if (normalized.includes("freight") || normalized.includes("shipping")) {
    return "freight";
  }
  return "other";
}

async function loadRegularTargets(db: KnexLike): Promise<RegularTarget[]> {
  const result = await db.raw(`
    SELECT vb.id, vb.number, vb.bill_type, vb.reference_id, vb.document_date,
           vb.vendor_qb_list_id_snapshot AS vendor_qb_list_id, vb.qb_txn_id,
           vb.service_vendor_bill_id, vb.freight_vendor_bill_id,
           vb.tariff_vendor_bill_id,
           COALESCE((
             SELECT SUM(
               CASE
                 WHEN COALESCE(l.line_type, 'product') = 'product'
                   THEN COALESCE(NULLIF(l.landed_unit_cost_cents, 0), l.unit_cost_cents)::bigint * l.qty
                 ELSE COALESCE(l.amount_cents, l.unit_cost_cents)::bigint
               END
             )
               FROM vendor_bill_line l
              WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL
           ), 0)::bigint AS total_cents
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
       AND vb.reference_id IS NOT NULL
       AND vb.document_date IS NOT NULL
       AND vb.vendor_qb_list_id_snapshot IS NOT NULL
       AND COALESCE(
             (qv.metadata ->> 'is_china_agent') = 'true'
             OR qv.metadata @> '{"is_china_agent": true}'::jsonb,
             false
           )
     ORDER BY vb.document_date, vb.number
  `);
  return result.rows.map((row) => ({
    id: asString(row.id),
    number: asString(row.number),
    bill_type: "regular",
    reference_id: asString(row.reference_id),
    document_date: dateOnly(row.document_date),
    vendor_qb_list_id: asString(row.vendor_qb_list_id),
    qb_txn_id: asString(row.qb_txn_id) || null,
    total_cents: asNumber(row.total_cents),
    service_vendor_bill_id:
      asString(row.service_vendor_bill_id) || null,
    freight_vendor_bill_id:
      asString(row.freight_vendor_bill_id) || null,
    tariff_vendor_bill_id:
      asString(row.tariff_vendor_bill_id) || null,
  }));
}

async function loadTargetBill(
  db: KnexLike,
  id: string,
  expectedType: Exclude<BillType, "regular">
): Promise<TargetBill | null> {
  const result = await db.raw(
    `
    SELECT id, number, bill_type, reference_id, document_date,
           vendor_qb_list_id_snapshot AS vendor_qb_list_id, qb_txn_id,
           COALESCE((
             SELECT SUM(
               CASE
                 WHEN COALESCE(l.line_type, 'product') = 'product'
                   THEN COALESCE(NULLIF(l.landed_unit_cost_cents, 0), l.unit_cost_cents)::bigint * l.qty
                 ELSE COALESCE(l.amount_cents, l.unit_cost_cents)::bigint
               END
             )
               FROM vendor_bill_line l
              WHERE l.vendor_bill_id = vendor_bill.id AND l.deleted_at IS NULL
           ), 0)::bigint AS total_cents
      FROM vendor_bill
     WHERE id = ?
       AND deleted_at IS NULL
       AND bill_type = ?
       AND number IS NOT NULL
       AND reference_id IS NOT NULL
       AND document_date IS NOT NULL
       AND vendor_qb_list_id_snapshot IS NOT NULL
    `,
    [id, expectedType]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: asString(row.id),
    number: asString(row.number),
    bill_type: expectedType,
    reference_id: asString(row.reference_id),
    document_date: dateOnly(row.document_date),
    vendor_qb_list_id: asString(row.vendor_qb_list_id),
    qb_txn_id: asString(row.qb_txn_id) || null,
    total_cents: asNumber(row.total_cents),
  };
}

async function loadLocalLines(
  db: KnexLike,
  billId: string
): Promise<LocalLine[]> {
  const result = await db.raw(
    `
    SELECT l.id,
           pv.metadata ->> 'quickbooks_id' AS qb_item_list_id,
           COALESCE(l.freight_account_list_id, l.qb_account_list_id)
             AS account_list_id,
           l.qty::numeric AS qty,
           CASE
             WHEN COALESCE(l.line_type, 'product') = 'product'
               THEN COALESCE(NULLIF(l.landed_unit_cost_cents, 0), l.unit_cost_cents)::bigint * l.qty
             ELSE COALESCE(l.amount_cents, l.unit_cost_cents)::bigint
           END AS amount_cents
      FROM vendor_bill_line l
      LEFT JOIN product_variant pv
        ON pv.id = l.product_variant_id AND pv.deleted_at IS NULL
     WHERE l.vendor_bill_id = ? AND l.deleted_at IS NULL
     ORDER BY l.created_at, l.id
    `,
    [billId]
  );
  return result.rows.map((row) => ({
    id: asString(row.id),
    qb_item_list_id: asString(row.qb_item_list_id) || null,
    account_list_id: asString(row.account_list_id) || null,
    qty: asNumber(row.qty),
    amount_cents: asNumber(row.amount_cents),
  }));
}

function selectQbBill(
  target: TargetBill,
  qbBills: QbBill[]
): { bill: QbBill | null; error: string | null } {
  if (target.qb_txn_id) {
    const byTxn = qbBills.filter((bill) => bill.txn_id === target.qb_txn_id);
    if (byTxn.length === 1) return { bill: byTxn[0]!, error: null };
    return {
      bill: null,
      error: `${target.number}: QB TxnID ${target.qb_txn_id} returned ${byTxn.length} matches`,
    };
  }

  const byRef = qbBills.filter(
    (bill) =>
      bill.vendor_list_id === target.vendor_qb_list_id &&
      bill.ref_number.trim().toLowerCase() ===
        target.reference_id.trim().toLowerCase() &&
      bill.total_cents === target.total_cents
  );
  if (byRef.length === 1) return { bill: byRef[0]!, error: null };

  const expectedExpenseKind =
    target.bill_type === "service" ? "commission" : target.bill_type;
  const byReferenceIdentity =
    target.bill_type === "regular"
      ? []
      : qbBills.filter(
          (bill) =>
            bill.vendor_list_id === target.vendor_qb_list_id &&
            bill.txn_date === target.document_date &&
            bill.ref_number.trim().toLowerCase() ===
              target.reference_id.trim().toLowerCase() &&
            bill.item_lines.length === 0 &&
            bill.expense_lines.some(
              (line) =>
                classifyClearing(line.account_full_name) ===
                expectedExpenseKind
            )
        );
  if (byReferenceIdentity.length === 1) {
    return { bill: byReferenceIdentity[0]!, error: null };
  }
  const byEconomicIdentity =
    target.bill_type === "regular"
      ? []
      : qbBills.filter(
          (bill) =>
            bill.vendor_list_id === target.vendor_qb_list_id &&
            bill.txn_date === target.document_date &&
            bill.total_cents === target.total_cents &&
            bill.item_lines.length === 0 &&
            bill.expense_lines.some(
              (line) =>
                classifyClearing(line.account_full_name) ===
                expectedExpenseKind
            )
        );
  if (byEconomicIdentity.length === 1) {
    return { bill: byEconomicIdentity[0]!, error: null };
  }
  return {
    bill: null,
    error:
      `${target.number}: reference ${target.reference_id} returned ` +
      `${byRef.length} QB matches by exact total ${target.total_cents} ` +
      `(${byEconomicIdentity.length} by date, amount and ${expectedExpenseKind} account); ` +
      `same-date ${expectedExpenseKind} candidates: ` +
      qbBills
        .filter(
          (bill) =>
            bill.vendor_list_id === target.vendor_qb_list_id &&
            bill.txn_date === target.document_date &&
            bill.expense_lines.some(
              (line) =>
                classifyClearing(line.account_full_name) ===
                expectedExpenseKind
            )
        )
        .map((bill) => `${bill.ref_number}:${bill.total_cents}@${bill.txn_id}`)
        .join(", "),
  };
}

function mapProductLines(
  target: TargetBill,
  localLines: LocalLine[],
  qbLines: QbBillItemLine[]
): { links: LineLink[]; errors: string[] } {
  const errors: string[] = [];
  const links: LineLink[] = [];
  const remaining = [...qbLines];

  for (const local of localLines.filter((line) => line.qb_item_list_id)) {
    const identityCandidates = remaining
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) =>
          line.item_list_id === local.qb_item_list_id &&
          Math.abs(line.quantity - local.qty) < 1e-9
      );
    const amountCandidates = identityCandidates.filter(
      ({ line }) => line.amount_cents === local.amount_cents
    );
    let candidates = amountCandidates;
    if (candidates.length !== 1 && identityCandidates.length > 0) {
      const distances = identityCandidates.map(({ line }) =>
        Math.abs(line.amount_cents - local.amount_cents)
      );
      const nearestDistance = Math.min(...distances);
      candidates = identityCandidates.filter(
        ({ line }) =>
          Math.abs(line.amount_cents - local.amount_cents) === nearestDistance
      );
    }
    if (candidates.length !== 1) {
      errors.push(
        `${target.number} line ${local.id}: item ${local.qb_item_list_id} qty ` +
        `${local.qty} amount ${local.amount_cents} matched ${candidates.length} QB lines; ` +
        `candidates=${identityCandidates
          .map(
            ({ line }) =>
              `${line.amount_cents}/${line.cost_cents}@${line.txn_line_id}`
          )
          .join(",")}`
      );
      continue;
    }
    const selected = candidates[0]!;
    links.push({
      local_line_id: local.id,
      qb_txn_line_id: selected.line.txn_line_id,
    });
    remaining.splice(selected.index, 1);
  }

  const localProductCount = localLines.filter(
    (line) => line.qb_item_list_id
  ).length;
  if (links.length !== localProductCount || remaining.length !== 0) {
    errors.push(
      `${target.number}: product coverage local=${localProductCount}, ` +
        `linked=${links.length}, unmatched_qb=${remaining.length}`
    );
  }
  return { links, errors };
}

function mapExpenseLines(
  target: TargetBill,
  localLines: LocalLine[],
  qbLines: QbBillExpenseLine[]
): { links: LineLink[]; errors: string[] } {
  const errors: string[] = [];
  const links: LineLink[] = [];
  const remaining = [...qbLines];
  const accountLines = localLines.filter((line) => line.account_list_id);

  for (const local of accountLines) {
    const exactCandidates = remaining
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.amount_cents === local.amount_cents);
    const candidates =
      exactCandidates.length === 1
        ? exactCandidates
        : remaining.length === 1
          ? [{ line: remaining[0]!, index: 0 }]
          : exactCandidates;
    if (candidates.length !== 1) {
      errors.push(
        `${target.number} line ${local.id}: account ${local.account_list_id} ` +
          `amount ${local.amount_cents} matched ${candidates.length} QB lines`
      );
      continue;
    }
    const selected = candidates[0]!;
    links.push({
      local_line_id: local.id,
      qb_txn_line_id: selected.line.txn_line_id,
      qb_account_list_id: selected.line.account_list_id,
    });
    remaining.splice(selected.index, 1);
  }

  if (links.length !== accountLines.length || remaining.length !== 0) {
    errors.push(
      `${target.number}: expense coverage local=${accountLines.length}, ` +
        `linked=${links.length}, unmatched_qb=${remaining.length}`
    );
  }
  return { links, errors };
}

function toClearingLines(qbBill: QbBill): ClearingLine[] {
  return qbBill.expense_lines.map((line) => ({
    kind: classifyClearing(line.account_full_name),
    account_list_id: line.account_list_id,
    account_full_name: line.account_full_name,
    amount_cents: line.amount_cents,
    qb_txn_line_id: line.txn_line_id,
  }));
}

async function buildBillLink(
  db: KnexLike,
  target: TargetBill,
  qbBills: QbBill[]
): Promise<{ link: BillLinkPlan | null; errors: string[] }> {
  const selected = selectQbBill(target, qbBills);
  if (!selected.bill) {
    return { link: null, errors: [selected.error ?? `${target.number}: no QB match`] };
  }
  const qbBill = selected.bill;
  if (qbBill.vendor_list_id !== target.vendor_qb_list_id) {
    return {
      link: null,
      errors: [`${target.number}: QB vendor does not match POS vendor`],
    };
  }

  const localLines = await loadLocalLines(db, target.id);
  const mapped =
    target.bill_type === "regular"
      ? mapProductLines(target, localLines, qbBill.item_lines)
      : mapExpenseLines(target, localLines, qbBill.expense_lines);

  return {
    link: {
      local_bill_id: target.id,
      local_number: target.number,
      bill_type: target.bill_type,
      qb_txn_id: qbBill.txn_id,
      qb_edit_sequence: qbBill.edit_sequence,
      qb_ref_number: qbBill.ref_number,
      qb_amount_due_cents: qbBill.amount_due_cents,
      line_links: mapped.links,
      // Preserve the complete QB expense identity for every split bill. This
      // also covers old component bills whose total was split across multiple
      // QB expense rows even when POS represented it as one aggregate line.
      clearing_lines: toClearingLines(qbBill),
    },
    errors: mapped.errors,
  };
}

async function buildPlan(db: KnexLike): Promise<BackfillPlan> {
  const regularTargets = await loadRegularTargets(db);
  if (regularTargets.length === 0) {
    return {
      query: { vendor_list_id: "", from_date: "", to_date: "" },
      qb_bill_count: 0,
      groups: [],
      errors: ["No owned China-agency Regular Bills with QB TxnID were found"],
    };
  }

  const vendorIds = [...new Set(regularTargets.map((bill) => bill.vendor_qb_list_id))];
  if (vendorIds.length !== 1) {
    return {
      query: { vendor_list_id: "", from_date: "", to_date: "" },
      qb_bill_count: 0,
      groups: [],
      errors: [`Expected one China-agent QB vendor, found ${vendorIds.length}`],
    };
  }
  const dates = regularTargets.map((bill) => bill.document_date).sort();
  const fromDate = previousDay(dates[0]!);
  const toDate = nextDay(dates[dates.length - 1]!);
  const vendorListId = vendorIds[0]!;
  const qbBills = await queryVendorBills({
    vendorListId,
    fromDate,
    toDate,
  });

  const groups: GroupPlan[] = [];
  for (const regular of regularTargets) {
    const group: GroupPlan = {
      regular_id: regular.id,
      regular_number: regular.number,
      links: [],
      errors: [],
    };
    const regularLink = await buildBillLink(db, regular, qbBills);
    if (regularLink.link) group.links.push(regularLink.link);
    group.errors.push(...regularLink.errors);

    const components: Array<{
      id: string | null;
      type: Exclude<BillType, "regular">;
    }> = [
      { id: regular.service_vendor_bill_id, type: "service" },
      { id: regular.freight_vendor_bill_id, type: "freight" },
      { id: regular.tariff_vendor_bill_id, type: "tariff" },
    ];
    for (const component of components) {
      if (!component.id) continue;
      const target = await loadTargetBill(db, component.id, component.type);
      if (!target) {
        group.errors.push(
          `${regular.number}: linked ${component.type} bill ${component.id} is incomplete or missing`
        );
        continue;
      }
      const componentLink = await buildBillLink(db, target, qbBills);
      if (componentLink.link) group.links.push(componentLink.link);
      group.errors.push(...componentLink.errors);
    }
    groups.push(group);
  }

  return {
    query: {
      vendor_list_id: vendorListId,
      from_date: fromDate,
      to_date: toDate,
    },
    qb_bill_count: qbBills.length,
    groups,
    errors: groups.flatMap((group) => group.errors),
  };
}

function printPlan(plan: BackfillPlan, apply: boolean): void {
  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(
    `QB query: vendor=${plan.query.vendor_list_id || "-"} ` +
      `${plan.query.from_date || "-"}..${plan.query.to_date || "-"} ` +
      `(${plan.qb_bill_count} bills)\n`
  );
  for (const group of plan.groups) {
    console.log(
      `${group.regular_number}: ${group.links.length} bill link(s), ` +
        `${group.errors.length} error(s)`
    );
    for (const link of group.links) {
      console.log(
        `  ${link.bill_type.padEnd(7)} ${link.local_number} -> ` +
          `${link.qb_ref_number}@${link.qb_txn_id} | ` +
          `${link.line_links.length} line(s)` +
          (link.clearing_lines
            ? ` + ${link.clearing_lines.length} clearing line(s)`
            : "")
      );
    }
    for (const error of group.errors) console.log(`  ERROR: ${error}`);
  }
  console.log(`\nTotal errors: ${plan.errors.length}`);
}

async function applyPlan(db: KnexLike, expected: BackfillPlan): Promise<void> {
  if (expected.errors.length > 0) {
    throw new Error(
      `Refusing apply: dry-run has ${expected.errors.length} error(s)`
    );
  }
  const trx = await db.transaction();
  try {
    await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [AUDIT_TAG]);
    for (const group of expected.groups) {
      for (const link of group.links) {
        const conflict = await trx.raw(
          `
          SELECT id FROM vendor_bill
           WHERE qb_txn_id = ?
             AND id <> ?
             AND deleted_at IS NULL
           LIMIT 1
          `,
          [link.qb_txn_id, link.local_bill_id]
        );
        if (conflict.rows.length > 0) {
          throw new Error(
            `${link.local_number}: QB TxnID already belongs to ${asString(
              conflict.rows[0]?.id
            )}`
          );
        }

        const header = await trx.raw(
          `
          UPDATE vendor_bill
             SET qb_txn_id = ?,
                 qb_edit_sequence = ?,
                 qb_ref_number = ?,
                 qb_amount_due_cents = ?,
                 qb_synced_at = NOW(),
                 qb_source = NULL,
                 status = 'synced',
                 qb_clearing_lines = ?::jsonb,
                 notes = concat_ws(E'\\n', NULLIF(notes, ''), ?::text),
                 updated_at = NOW()
           WHERE id = ? AND deleted_at IS NULL
           RETURNING id
          `,
          [
            link.qb_txn_id,
            link.qb_edit_sequence,
            link.qb_ref_number,
            link.qb_amount_due_cents,
            link.clearing_lines == null
              ? null
              : JSON.stringify(link.clearing_lines),
            `${AUDIT_TAG} Deep-linked QB Bill header and line identities.`,
            link.local_bill_id,
          ]
        );
        if (header.rows.length !== 1) {
          throw new Error(`${link.local_number}: header write guard failed`);
        }

        for (const line of link.line_links) {
          const updated = await trx.raw(
            `
            UPDATE vendor_bill_line
               SET qb_txn_line_id = ?,
                   qb_account_list_id = COALESCE(?, qb_account_list_id),
                   updated_at = NOW()
             WHERE id = ?
               AND vendor_bill_id = ?
               AND deleted_at IS NULL
             RETURNING id
            `,
            [
              line.qb_txn_line_id,
              line.qb_account_list_id ?? null,
              line.local_line_id,
              link.local_bill_id,
            ]
          );
          if (updated.rows.length !== 1) {
            throw new Error(
              `${link.local_number}: line ${line.local_line_id} write guard failed`
            );
          }
        }
      }
    }
    await trx.commit();
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

export default async function backfillChinaAgencyQbBillLinks({
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
        ...plan,
      },
      null,
      2
    )
  );
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) {
    console.log("DRY-RUN only. Pass positional `apply` to execute.");
    return;
  }
  await applyPlan(db, plan);
  console.log(
    `Applied ${plan.groups.length} group(s), ` +
      `${plan.groups.reduce((sum, group) => sum + group.links.length, 0)} bill link(s).`
  );
}
