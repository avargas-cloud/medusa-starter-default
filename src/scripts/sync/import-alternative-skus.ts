/**
 * src/scripts/sync/import-alternative-skus.ts
 *
 * Reads the "Alternative_SKU" sheet from the purchasing Excel file and
 * populates the product_alternative table.
 *
 * Sheet format (Alternative_SKU):
 *   Row 1: "Alternative SKU List"         (title, skip)
 *   Row 2: "Item", "Item 1" ... "Item 10" (headers, skip)
 *   Row 3+: primary_sku, alt1, alt2, ...  (data)
 *
 * The Excel file is a ZIP — we extract and parse the XML directly
 * (no openpyxl required).
 *
 * Usage (dry-run):
 *   npx ts-node -r tsconfig-paths/register src/scripts/sync/import-alternative-skus.ts
 *
 * Usage (apply):
 *   APPLY=true npx ts-node -r tsconfig-paths/register src/scripts/sync/import-alternative-skus.ts
 *
 * The Excel file must be at: <workspace-root>/Purchasing Analysis General 2026-04-22.xlsm
 * or set EXCEL_PATH env var to override.
 */

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AdmZip = require("adm-zip") as typeof import("adm-zip");
import { XMLParser } from "fast-xml-parser";
import { Client } from "pg";

dotenv.config();

const APPLY = process.env.APPLY === "true";
const EXCEL_PATH =
  process.env.EXCEL_PATH ||
  path.join(__dirname, "../../../../", "Purchasing Analysis General 2026-04-22.xlsm");

// ── XML helpers ─────────────────────────────────────────────────────────────

function extractSharedStrings(zip: AdmZip): string[] {
  const entry = zip.getEntry("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = entry.getData().toString("utf8");
  const parser = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "si" || name === "r" });
  const parsed = parser.parse(xml);
  const sis: unknown[] = parsed?.sst?.si ?? [];
  return sis.map((si: unknown) => {
    const siObj = si as Record<string, unknown>;
    // Single <t>
    if (typeof siObj.t === "string") return siObj.t;
    if (typeof (siObj.t as Record<string, unknown>)?.["#text"] === "string") {
      return (siObj.t as Record<string, unknown>)["#text"] as string;
    }
    // Rich text <r><t>
    if (Array.isArray(siObj.r)) {
      return (siObj.r as Array<Record<string, unknown>>)
        .map((r) => {
          if (typeof r.t === "string") return r.t;
          if (typeof (r.t as Record<string, unknown>)?.["#text"] === "string")
            return (r.t as Record<string, unknown>)["#text"] as string;
          return "";
        })
        .join("");
    }
    return "";
  });
}

function getCellValue(
  cell: Record<string, unknown>,
  shared: string[]
): string {
  const type = cell["@_t"] as string | undefined;
  const vNode = cell.v;
  const v = typeof vNode === "number" ? String(vNode) : (vNode as string) ?? "";
  if (type === "s") return shared[parseInt(v, 10)] ?? "";
  return v;
}

function parseAlternativeSheet(zip: AdmZip, shared: string[]): string[][] {
  // Find the Alternative_SKU sheet file
  const wbEntry = zip.getEntry("xl/workbook.xml");
  if (!wbEntry) throw new Error("workbook.xml not found");
  const wbXml = wbEntry.getData().toString("utf8");
  const wbParser = new XMLParser({ ignoreAttributes: false, isArray: (n) => n === "sheet" });
  const wb = wbParser.parse(wbXml);
  const sheets: Array<Record<string, unknown>> = wb?.workbook?.sheets?.sheet ?? [];

  const altSheet = sheets.find(
    (s) => (s["@_name"] as string)?.trim() === "Alternative_SKU"
  );
  if (!altSheet) throw new Error('Sheet "Alternative_SKU" not found in workbook');

  const rId = altSheet["@_r:id"] as string;

  // Resolve rId → filename
  const relEntry = zip.getEntry("xl/_rels/workbook.xml.rels");
  if (!relEntry) throw new Error("workbook.xml.rels not found");
  const relXml = relEntry.getData().toString("utf8");
  const relParser = new XMLParser({ ignoreAttributes: false, isArray: (n) => n === "Relationship" });
  const rels = relParser.parse(relXml);
  const relationships: Array<Record<string, unknown>> =
    rels?.Relationships?.Relationship ?? [];
  const rel = relationships.find((r) => r["@_Id"] === rId);
  if (!rel) throw new Error(`Relationship ${rId} not found`);
  const sheetFile = `xl/${(rel["@_Target"] as string).replace(/^worksheets\//, "worksheets/")}`;

  const sheetEntry = zip.getEntry(sheetFile);
  if (!sheetEntry) throw new Error(`Sheet file ${sheetFile} not found in ZIP`);
  const sheetXml = sheetEntry.getData().toString("utf8");

  const sParser = new XMLParser({
    ignoreAttributes: false,
    isArray: (n) => n === "row" || n === "c",
  });
  const sheet = sParser.parse(sheetXml);
  const rows: Array<Record<string, unknown>> =
    sheet?.worksheet?.sheetData?.row ?? [];

  const result: string[][] = [];
  for (const row of rows) {
    const cells: Array<Record<string, unknown>> = (row.c as Array<Record<string, unknown>>) ?? [];
    const values = cells.map((c) => getCellValue(c, shared).trim());
    result.push(values);
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`Excel file not found: ${EXCEL_PATH}`);
    console.error(`Place the file in the workspace root or set EXCEL_PATH env var.`);
    process.exit(1);
  }

  console.log(`Reading: ${path.basename(EXCEL_PATH)}`);
  const zip = new AdmZip(EXCEL_PATH);
  const shared = extractSharedStrings(zip);
  const rows = parseAlternativeSheet(zip, shared);

  // rows[0] = "Alternative SKU List" title → skip
  // rows[1] = "Item", "Item 1" ... headers → skip
  // rows[2+] = data
  const dataRows = rows.slice(2).filter((r) => r[0] && r[0] !== "Item");

  // Build pairs: (primary_sku, alt_sku, priority)
  type Pair = { primary: string; alt: string; priority: number };
  const pairs: Pair[] = [];

  for (const row of dataRows) {
    const primary = row[0];
    if (!primary) continue;
    for (let i = 1; i < row.length; i++) {
      const alt = row[i];
      if (!alt) continue;
      pairs.push({ primary, alt, priority: i });
    }
  }

  console.log(`Found ${dataRows.length} primary SKUs, ${pairs.length} alternative pairs`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    // Resolve SKUs → variant IDs
    const allSkus = [...new Set([...pairs.map((p) => p.primary), ...pairs.map((p) => p.alt)])];
    const variantRes = await db.query<{ id: string; sku: string }>(
      `SELECT id, sku FROM product_variant WHERE sku = ANY($1::text[]) AND deleted_at IS NULL`,
      [allSkus]
    );
    const skuToId = new Map(variantRes.rows.map((r) => [r.sku, r.id]));

    console.log(`Matched ${skuToId.size} / ${allSkus.length} SKUs in Medusa`);

    const missing = allSkus.filter((s) => !skuToId.has(s));
    if (missing.length > 0) {
      console.warn(`⚠  ${missing.length} SKUs not found in Medusa (will skip):`);
      missing.slice(0, 20).forEach((s) => console.warn(`   - ${s}`));
      if (missing.length > 20) console.warn(`   ... and ${missing.length - 20} more`);
    }

    // Filter to pairs where both sides are known
    const resolvablePairs = pairs.filter(
      (p) => skuToId.has(p.primary) && skuToId.has(p.alt)
    );
    console.log(`Resolvable pairs: ${resolvablePairs.length}`);

    if (!APPLY) {
      console.log(`\nDRY-RUN — no changes written. Set APPLY=true to apply.\n`);
      console.log(`Sample (first 10 pairs):`);
      resolvablePairs.slice(0, 10).forEach((p) =>
        console.log(`  ${p.primary} → ${p.alt} (priority ${p.priority})`)
      );
      return;
    }

    // Upsert pairs
    let inserted = 0;
    let skipped = 0;

    for (const p of resolvablePairs) {
      const primaryId = skuToId.get(p.primary)!;
      const altId = skuToId.get(p.alt)!;

      // Generate ID matching model.id({ prefix: "palt" }) pattern
      const id = `palt_${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;

      const res = await db.query(
        `INSERT INTO product_alternative
           (id, primary_variant_id, alt_variant_id, priority, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, now(), now())
         ON CONFLICT (primary_variant_id, alt_variant_id) DO UPDATE
           SET priority   = EXCLUDED.priority,
               is_active  = true,
               updated_at = now()
         RETURNING (xmax = 0) AS is_insert`,
        [id, primaryId, altId, p.priority]
      );

      if (res.rows[0]?.is_insert) inserted++;
      else skipped++;
    }

    console.log(`\n✓ Done.`);
    console.log(`  Inserted: ${inserted}`);
    console.log(`  Updated:  ${skipped}`);
    console.log(`  Skipped (missing SKUs): ${pairs.length - resolvablePairs.length}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
