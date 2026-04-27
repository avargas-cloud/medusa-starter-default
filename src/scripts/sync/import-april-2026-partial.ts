/**
 * One-off import — loads the April 1-13, 2026 partial Excel from QuickBooks
 * into purchasing_sales_history with source='excel_import'. This row covers
 * the days BEFORE Medusa go-live (2026-04-14); the tier0 engine combines it
 * with pos_invoice for days 14-today, and the May-2 monthly consolidator
 * will add the Medusa half (days 14-30) once April closes.
 *
 * Excel format (validated against the file):
 *   Row 1: "Ecopowertech, Inc."
 *   Row 3: "April 1 - 13, 2026"
 *   Row 5: column headers (Qty, Amount, ...)
 *   Row 7+: data rows → Col C = SKU, Col E = Qty, Col F = Amount
 *   Skip rows where Col C is empty/None or starts with "Total"/"Discount".
 *
 * Usage (dry-run):
 *   npx medusa exec ./src/scripts/sync/import-april-2026-partial.ts
 * Usage (apply):
 *   APPLY=true npx medusa exec ./src/scripts/sync/import-april-2026-partial.ts
 */

import * as path from "path";
import { Client } from "pg";

const AdmZip = require("adm-zip") as typeof import("adm-zip");
const { XMLParser } = require("fast-xml-parser");

const APPLY = process.env.APPLY === "true";
const MONTH_DATE = "2026-04-01";
const SOURCE = "excel_import";
const EXCEL_PATH = path.join(
  __dirname,
  "../../../../",
  "april 2025 from 1 to 13.xlsx"
);

interface ParsedRow {
  sku: string;
  qty: number;
  revenue: number;
}

function getSharedStrings(zip: InstanceType<typeof AdmZip>): string[] {
  const entry = zip.getEntry("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = entry.getData().toString("utf8");
  const p = new XMLParser({
    ignoreAttributes: false,
    isArray: (n: string) => n === "si" || n === "r",
  });
  const parsed = p.parse(xml);
  return (parsed?.sst?.si ?? []).map((si: Record<string, unknown>) => {
    if (typeof si.t === "string") return si.t;
    const t = si.t as Record<string, unknown> | undefined;
    if (typeof t?.["#text"] === "string") return t["#text"] as string;
    if (Array.isArray(si.r)) {
      return (si.r as Array<Record<string, unknown>>)
        .map((r) => {
          const rt = r.t as Record<string, unknown> | string | undefined;
          if (typeof rt === "string") return rt;
          if (rt && typeof rt === "object" && typeof rt["#text"] === "string")
            return rt["#text"];
          return "";
        })
        .join("");
    }
    return "";
  });
}

function colLetter(ref: string): string {
  return (ref.match(/^([A-Z]+)/)?.[1] ?? "").toUpperCase();
}

function rowNum(ref: string): number {
  return parseInt(ref.match(/(\d+)$/)?.[1] ?? "0", 10);
}

function cellValue(
  cell: Record<string, unknown>,
  shared: string[]
): string | number | null {
  const v = (cell.v as Record<string, unknown> | string | number | undefined);
  if (v == null) return null;
  const raw = typeof v === "object" ? (v as Record<string, unknown>)["#text"] : v;
  if (raw == null) return null;
  const t = (cell["@_t"] as string | undefined) ?? "n";
  if (t === "s") {
    const idx = parseInt(String(raw), 10);
    return shared[idx] ?? "";
  }
  return String(raw);
}

function parseExcel(): ParsedRow[] {
  const zip = new AdmZip(EXCEL_PATH);
  const shared = getSharedStrings(zip);
  const sheetEntry = zip.getEntry("xl/worksheets/sheet1.xml");
  if (!sheetEntry) throw new Error("sheet1.xml not found in workbook");
  const xml = sheetEntry.getData().toString("utf8");
  const p = new XMLParser({ ignoreAttributes: true, attributeNamePrefix: "@_", isArray: (n: string) => n === "row" || n === "c" });
  // Override: keep attributes for cells (we need r= for ref and t= for type).
  const p2 = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (n: string) => n === "row" || n === "c",
  });
  const parsed = p2.parse(xml);
  const rows = parsed?.worksheet?.sheetData?.row ?? [];

  const out: ParsedRow[] = [];
  for (const r of rows as Array<Record<string, unknown>>) {
    const rRef = (r["@_r"] as string) ?? "0";
    const rNum = parseInt(rRef, 10);
    if (rNum < 7) continue; // skip header rows

    const cells = (r.c as Array<Record<string, unknown>>) ?? [];
    let sku: string | null = null;
    let qty: number | null = null;
    let revenue: number | null = null;

    for (const c of cells) {
      const ref = (c["@_r"] as string) ?? "";
      const col = colLetter(ref);
      const val = cellValue(c, shared);
      if (val == null) continue;
      if (col === "C") sku = String(val).trim();
      else if (col === "E") qty = parseFloat(String(val));
      else if (col === "F") revenue = parseFloat(String(val));
    }

    if (!sku) continue;
    // Skip subtotal/aggregate rows
    if (/^(total|discount|inventory)/i.test(sku)) continue;
    if (qty == null) continue;
    out.push({ sku, qty, revenue: revenue ?? 0 });
  }
  return out;
}

export default async function importApril2026Partial(): Promise<void> {
  console.log(`[apr-2026-import] Reading ${EXCEL_PATH}...`);
  const parsed = parseExcel();
  console.log(`[apr-2026-import] Parsed ${parsed.length} rows from Excel.`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    // Map SKU → variant_id
    const skus = parsed.map((r) => r.sku);
    const variantRes = await db.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM product_variant
       WHERE sku = ANY($1::text[]) AND deleted_at IS NULL`,
      [skus]
    );
    const skuToVariant = new Map(variantRes.rows.map((r) => [r.sku, r.id]));

    const matched: ParsedRow[] = [];
    const unmatched: ParsedRow[] = [];
    for (const r of parsed) {
      if (skuToVariant.has(r.sku)) matched.push(r);
      else unmatched.push(r);
    }

    console.log(
      `[apr-2026-import] ${matched.length} SKUs matched, ${unmatched.length} unmatched.`
    );
    if (unmatched.length > 0 && unmatched.length < 30) {
      console.log(
        `[apr-2026-import] Unmatched SKUs: ${unmatched.map((r) => r.sku).join(", ")}`
      );
    }

    const totalQty = matched.reduce((s, r) => s + r.qty, 0);
    const totalRev = matched.reduce((s, r) => s + r.revenue, 0);
    console.log(
      `[apr-2026-import] Totals — qty=${totalQty}, revenue=$${totalRev.toFixed(2)}`
    );

    if (!APPLY) {
      console.log(
        `[apr-2026-import] DRY RUN. Re-run with APPLY=true to write to purchasing_sales_history.`
      );
      return;
    }

    // Batch upsert
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const r of matched) {
      const id = `psh_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
      const variantId = skuToVariant.get(r.sku)!;
      values.push(id, variantId, MONTH_DATE, r.qty, r.revenue);
      placeholders.push(
        `($${p},$${p + 1},$${p + 2}::date,$${p + 3},$${p + 4},'${SOURCE}',now(),now())`
      );
      p += 5;
    }
    await db.query(
      `INSERT INTO purchasing_sales_history
         (id, variant_id, month_date, qty_sold, revenue, source, created_at, updated_at)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (variant_id, month_date, source)
       DO UPDATE SET qty_sold = EXCLUDED.qty_sold,
                     revenue  = EXCLUDED.revenue,
                     updated_at = now()`,
      values
    );
    console.log(`[apr-2026-import] ✓ Inserted/updated ${matched.length} rows.`);
  } finally {
    await db.end();
  }
}
