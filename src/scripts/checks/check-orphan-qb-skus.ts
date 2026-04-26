/**
 * src/scripts/checks/check-orphan-qb-skus.ts
 *
 * Finds SKUs present in the QuickBooks Excel monthly sales file
 * that do NOT exist in Medusa's product_variant table.
 *
 * These "orphan" SKUs are silently skipped during the regular import,
 * which distorts Pareto analysis and purchasing decisions.
 *
 * Usage:
 *   yarn ts-node -r tsconfig-paths/register src/scripts/checks/check-orphan-qb-skus.ts
 *
 * Optional env vars:
 *   EXCEL_PATH — override Excel file path (default: workspace root .xlsm)
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { Client } from "pg";

const AdmZip = require("adm-zip") as typeof import("adm-zip");
const { XMLParser } = require("fast-xml-parser");

dotenv.config();

const EXCEL_PATH =
  process.env.EXCEL_PATH ||
  path.join(__dirname, "../../../../", "Purchasing Analysis General 2026-04-22.xlsm");

const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

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

function getSheetXml(zip: InstanceType<typeof AdmZip>, sheetName: string): string | null {
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

type SkuMonthEntry = { monthDate: string; qty: number; amount: number };

async function main() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`Excel file not found: ${EXCEL_PATH}`);
    process.exit(1);
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  const cutoffStr = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-01`;

  console.log(`\nReading: ${path.basename(EXCEL_PATH)}`);
  console.log(`Cutoff (last 12 months): ${cutoffStr}\n`);

  const zip = new AdmZip(EXCEL_PATH);
  const shared = getSharedStrings(zip);

  // sku → list of monthly entries
  const skuData = new Map<string, SkuMonthEntry[]>();

  for (const sheetName of ["1","2","3","4","5","6","7","8","9","10","11","12"]) {
    const xml = getSheetXml(zip, sheetName);
    if (!xml) continue;

    const p = new XMLParser({ ignoreAttributes: false, isArray: (n: string) => n === "row" || n === "c" });
    const sheet = p.parse(xml);
    const rows: Array<Record<string, unknown>> = sheet?.worksheet?.sheetData?.row ?? [];

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

    if (!monthDate || monthDate < cutoffStr) continue;

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
      if (sku.toLowerCase().startsWith("total") || sku.toLowerCase().startsWith("discount")) continue;
      if (!sku.includes("-") && !sku.match(/^[A-Z0-9]{4,}/)) continue;

      const qty = parseFloat(qtyStr);
      const amount = parseFloat(amtStr ?? "0");
      if (isNaN(qty) || qty < 0) continue;

      if (!skuData.has(sku)) skuData.set(sku, []);
      skuData.get(sku)!.push({ monthDate, qty: Math.round(qty), amount: isNaN(amount) ? 0 : amount });
    }
  }

  const allSkus = [...skuData.keys()];
  console.log(`Total unique SKUs in Excel (last 12 months): ${allSkus.length}`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    const res = await db.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM product_variant WHERE sku = ANY($1::text[]) AND deleted_at IS NULL`,
      [allSkus]
    );
    const foundSkus = new Set(res.rows.map((r) => r.sku));

    const orphans = allSkus.filter((s) => !foundSkus.has(s));

    console.log(`Matched in Medusa:     ${foundSkus.size}`);
    console.log(`NOT in Medusa (orphan): ${orphans.length}`);

    if (orphans.length === 0) {
      console.log("\n✓ All SKUs found in Medusa — no orphans.");
      return;
    }

    // Build summary per orphan SKU: total qty, total revenue, months active
    type OrphanSummary = { sku: string; totalQty: number; totalRevenue: number; months: number };
    const summaries: OrphanSummary[] = orphans.map((sku) => {
      const entries = skuData.get(sku)!;
      const totalQty = entries.reduce((s, e) => s + e.qty, 0);
      const totalRevenue = entries.reduce((s, e) => s + e.amount, 0);
      return { sku, totalQty, totalRevenue, months: entries.length };
    });

    // Sort by total revenue descending (highest impact first)
    summaries.sort((a, b) => b.totalRevenue - a.totalRevenue);

    const totalOrphanRevenue = summaries.reduce((s, o) => s + o.totalRevenue, 0);
    const totalOrphanQty = summaries.reduce((s, o) => s + o.totalQty, 0);

    console.log(`\n${"SKU".padEnd(30)} ${"Qty".padStart(8)} ${"Revenue".padStart(12)} ${"Months".padStart(7)}`);
    console.log("─".repeat(62));
    for (const o of summaries) {
      console.log(
        `${o.sku.padEnd(30)} ${String(o.totalQty).padStart(8)} ${("$" + o.totalRevenue.toFixed(2)).padStart(12)} ${String(o.months).padStart(7)}`
      );
    }
    console.log("─".repeat(62));
    console.log(
      `${"TOTAL".padEnd(30)} ${String(totalOrphanQty).padStart(8)} ${("$" + totalOrphanRevenue.toFixed(2)).padStart(12)}`
    );

    console.log(`\n⚠  These ${orphans.length} SKUs exist in QuickBooks but NOT in Medusa.`);
    console.log(`   Their sales data ($${totalOrphanRevenue.toFixed(2)} / ${totalOrphanQty} units) is excluded from Pareto analysis.`);
    console.log(`   Action: review the list above and create the relevant SKUs in Medusa before re-running the import.`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
