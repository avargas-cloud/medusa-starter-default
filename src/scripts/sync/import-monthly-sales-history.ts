/**
 * src/scripts/sync/import-monthly-sales-history.ts
 *
 * Reads the individual monthly sheets (1=Jan … 12=Dec) from the purchasing
 * Excel and inserts them into purchasing_sales_history (source='excel_import').
 *
 * Sheet format:
 *   Row 1: Company name
 *   Row 2: "Sales by Item Summary"
 *   Row 3: Month name + year  (e.g. "January 2026")
 *   Row 4-6: Column headers
 *   Row 7+: Data rows  → Col C = SKU, Col E = Qty sold
 *
 * Only months within the last 12 months from today are imported.
 *
 * Usage (dry-run):
 *   yarn ts-node -r tsconfig-paths/register src/scripts/sync/import-monthly-sales-history.ts
 *
 * Usage (apply):
 *   APPLY=true yarn ts-node -r tsconfig-paths/register src/scripts/sync/import-monthly-sales-history.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { Client } from "pg";

const AdmZip = require("adm-zip") as typeof import("adm-zip");
const { XMLParser } = require("fast-xml-parser");

dotenv.config();

const APPLY = process.env.APPLY === "true";
const EXCEL_PATH =
  process.env.EXCEL_PATH ||
  path.join(__dirname, "../../../../", "Purchasing Analysis General 2026-04-22.xlsm");

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// ── XML helpers ───────────────────────────────────────────────────────────────

function getSharedStrings(zip: InstanceType<typeof AdmZip>): string[] {
  const entry = zip.getEntry("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = entry.getData().toString("utf8");
  const p = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "si" || n === "r" });
  const parsed = p.parse(xml);
  return (parsed?.sst?.si ?? []).map((si: Record<string, unknown>) => {
    if (typeof si.t === "string") return si.t;
    if (typeof (si.t as Record<string, unknown>)?.["#text"] === "string")
      return (si.t as Record<string, unknown>)["#text"] as string;
    if (Array.isArray(si.r))
      return (si.r as Array<Record<string, unknown>>)
        .map((r) => r.t?.["#text"] ?? r.t ?? "").join("");
    return "";
  });
}

function getSheetXml(
  zip: InstanceType<typeof AdmZip>,
  sheetName: string
): string | null {
  const wbXml = zip.getEntry("xl/workbook.xml")?.getData().toString("utf8");
  if (!wbXml) return null;
  const wbP = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "sheet" });
  const wb = wbP.parse(wbXml);
  const sheet = (wb?.workbook?.sheets?.sheet ?? []).find(
    (s: Record<string, unknown>) => s["@_name"] === sheetName
  );
  if (!sheet) return null;
  const rId = sheet["@_r:id"] as string;
  const relXml = zip.getEntry("xl/_rels/workbook.xml.rels")?.getData().toString("utf8");
  if (!relXml) return null;
  const relP = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "Relationship" });
  const rels = relP.parse(relXml);
  const rel = (rels?.Relationships?.Relationship ?? []).find(
    (r: Record<string, unknown>) => r["@_Id"] === rId
  );
  if (!rel) return null;
  return zip.getEntry(`xl/${rel["@_Target"] as string}`)?.getData().toString("utf8") ?? null;
}

function cellVal(cell: Record<string, unknown>, shared: string[]): string {
  const type = cell["@_t"] as string | undefined;
  const v = cell.v !== undefined ? String(cell.v) : "";
  if (type === "s") return shared[parseInt(v, 10)] ?? "";
  return v;
}

function cellRef(cell: Record<string, unknown>): { col: string; row: number } {
  const ref = (cell["@_r"] as string) ?? "";
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  return { col: match?.[1] ?? "", row: parseInt(match?.[2] ?? "0", 10) };
}

// ── Parse one sheet ───────────────────────────────────────────────────────────

type SheetResult = {
  monthDate: string;  // YYYY-MM-01
  rows: Array<{ sku: string; qty: number; amount: number }>;
};

function parseMonthlySheet(
  zip: InstanceType<typeof AdmZip>,
  sheetName: string,
  shared: string[]
): SheetResult | null {
  const xml = getSheetXml(zip, sheetName);
  if (!xml) return null;

  const p = new XMLParser({
    ignoreAttributes: false,
    isArray: (n: string) => n === "row" || n === "c",
  });
  const sheet = p.parse(xml);
  const rows: Array<Record<string, unknown>> = sheet?.worksheet?.sheetData?.row ?? [];

  // Row 3 contains the month/year (e.g., "January 2026")
  let monthDate: string | null = null;
  for (const row of rows.slice(0, 5)) {
    const cells: Array<Record<string, unknown>> = (row.c as Array<Record<string, unknown>>) ?? [];
    for (const cell of cells) {
      const val = cellVal(cell, shared).trim();
      const match = val.match(/^([A-Za-z]+)\s+(\d{4})$/);
      if (match) {
        const monthNum = MONTH_NAMES[match[1].toLowerCase()];
        if (monthNum) {
          monthDate = `${match[2]}-${String(monthNum).padStart(2, "0")}-01`;
          break;
        }
      }
    }
    if (monthDate) break;
  }

  if (!monthDate) {
    console.warn(`  Sheet "${sheetName}": could not detect month/year — skipping`);
    return null;
  }

  // Data rows: col C = SKU, col E = Qty, col F = Amount
  const dataRows: Array<{ sku: string; qty: number; amount: number }> = [];

  for (const row of rows) {
    const cells: Array<Record<string, unknown>> = (row.c as Array<Record<string, unknown>>) ?? [];
    const byCol: Record<string, string> = {};
    for (const cell of cells) {
      const { col } = cellRef(cell);
      byCol[col] = cellVal(cell, shared).trim();
    }
    const sku = byCol["C"];
    const qtyStr = byCol["E"];
    const amtStr = byCol["F"];

    if (!sku || !qtyStr) continue;
    // Skip header/total/discount rows
    if (sku.toLowerCase().startsWith("total") || sku.toLowerCase().startsWith("discount")) continue;
    if (!sku.includes("-") && !sku.match(/^[A-Z0-9]{4,}/)) continue;

    const qty = parseFloat(qtyStr);
    const amount = parseFloat(amtStr ?? "0");
    if (isNaN(qty) || qty < 0) continue;

    dataRows.push({ sku, qty: Math.round(qty), amount: isNaN(amount) ? 0 : amount });
  }

  return { monthDate, rows: dataRows };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`Excel file not found: ${EXCEL_PATH}`);
    process.exit(1);
  }

  // Only import months within the last 12 months
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-01`;

  console.log(`Reading: ${path.basename(EXCEL_PATH)}`);
  console.log(`Cutoff (ignore older than): ${cutoffStr}`);

  const zip = new AdmZip(EXCEL_PATH);
  const shared = getSharedStrings(zip);

  const allRecords: Array<{ monthDate: string; sku: string; qty: number; amount: number }> = [];

  for (const sheetName of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]) {
    const result = parseMonthlySheet(zip, sheetName, shared);
    if (!result) continue;

    if (result.monthDate < cutoffStr) {
      console.log(`  Sheet "${sheetName}" → ${result.monthDate} — OLDER than 12 months, skipping`);
      continue;
    }

    const nonZero = result.rows.filter((r) => r.qty > 0).length;
    console.log(
      `  Sheet "${sheetName}" → ${result.monthDate} — ${result.rows.length} SKUs, ${nonZero} with sales`
    );
    for (const row of result.rows) {
      allRecords.push({ monthDate: result.monthDate, sku: row.sku, qty: row.qty, amount: row.amount });
    }
  }

  console.log(`\nTotal records to process: ${allRecords.length}`);

  // Resolve SKUs → variant IDs
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    const allSkus = [...new Set(allRecords.map((r) => r.sku))];
    const varRes = await db.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM product_variant WHERE sku = ANY($1::text[]) AND deleted_at IS NULL`,
      [allSkus]
    );
    const skuToId = new Map(varRes.rows.map((r) => [r.sku, r.id]));
    console.log(`Matched ${skuToId.size} / ${allSkus.length} SKUs in Medusa`);

    const resolvable = allRecords.filter((r) => skuToId.has(r.sku));
    const unresolved = allSkus.filter((s) => !skuToId.has(s));

    console.log(`Resolvable records: ${resolvable.length}`);
    if (unresolved.length > 0) {
      console.warn(`⚠  ${unresolved.length} SKUs not in Medusa (will skip):`);
      unresolved.slice(0, 10).forEach((s) => console.warn(`   - ${s}`));
      if (unresolved.length > 10) console.warn(`   ... and ${unresolved.length - 10} more`);
    }

    if (!APPLY) {
      console.log(`\nDRY-RUN — no changes written. Set APPLY=true to apply.`);
      console.log(`\nSample (first 10):`);
      resolvable.slice(0, 10).forEach((r) =>
        console.log(`  ${r.monthDate} | ${r.sku.padEnd(25)} | qty=${r.qty} | $${r.amount.toFixed(2)}`)
      );
      return;
    }

    let inserted = 0;
    let updated = 0;

    for (const r of resolvable) {
      const variantId = skuToId.get(r.sku)!;
      const id = `psh_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;

      const res = await db.query(
        `INSERT INTO purchasing_sales_history
           (id, variant_id, month_date, qty_sold, revenue, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'excel_import', now(), now())
         ON CONFLICT (variant_id, month_date, source)
         DO UPDATE SET qty_sold = EXCLUDED.qty_sold, revenue = EXCLUDED.revenue, updated_at = now()
         RETURNING (xmax = 0) AS is_insert`,
        [id, variantId, r.monthDate, r.qty, r.amount]
      );

      if (res.rows[0]?.is_insert) inserted++;
      else updated++;
    }

    console.log(`\n✓ Done.`);
    console.log(`  Inserted: ${inserted}`);
    console.log(`  Updated:  ${updated}`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
