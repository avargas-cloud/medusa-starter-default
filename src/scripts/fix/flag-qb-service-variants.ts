/**
 * flag-qb-service-variants.ts
 *
 * Marks product variants as QB "service / non-inventory" items by setting
 * `metadata.quickbooks_is_service = true`. Service items must NOT carry
 * <InventorySiteRef> in QBXML — emitting it triggers QB error 3140
 * ("Site cannot be set on a non-inventory lineitem"). The flag is honored
 * by `buildQbItems` in `lib/quickbooks/order-flow-core.ts`, which then
 * sets `noSite: true` on every line generated for Estimates, Sales Orders,
 * Invoices, Sales Receipts, and Credit Memos.
 *
 * Usage:
 *   cd backend
 *   # dry-run by SKU list (comma-separated or space-separated)
 *   yarn ts-node src/scripts/fix/flag-qb-service-variants.ts --skus "ELAB-SC-1S-P,OTHER-SKU"
 *   # dry-run by SKU prefix
 *   yarn ts-node src/scripts/fix/flag-qb-service-variants.ts --prefix "ELAB-SC-"
 *   # dry-run reading SKUs from a file (one per line)
 *   yarn ts-node src/scripts/fix/flag-qb-service-variants.ts --file scripts/fix/service-skus.txt
 *   # apply changes
 *   yarn ts-node src/scripts/fix/flag-qb-service-variants.ts --skus "ELAB-SC-1S-P" --execute
 *   # unflag (restore to inventory)
 *   yarn ts-node src/scripts/fix/flag-qb-service-variants.ts --skus "ELAB-SC-1S-P" --unflag --execute
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import postgres from "postgres";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--execute");
const UNFLAG = args.includes("--unflag");

function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  if (i < 0 || i === args.length - 1) return null;
  return args[i + 1];
}

function parseSkusFromCli(): string[] {
  const out = new Set<string>();
  const inline = argValue("--skus");
  if (inline) {
    for (const raw of inline.split(/[,\s]+/)) {
      const sku = raw.trim();
      if (sku) out.add(sku);
    }
  }
  const file = argValue("--file");
  if (file) {
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) {
      throw new Error(`SKU file not found: ${abs}`);
    }
    for (const raw of fs.readFileSync(abs, "utf8").split(/\r?\n/)) {
      const sku = raw.trim();
      if (sku && !sku.startsWith("#")) out.add(sku);
    }
  }
  return [...out];
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("❌ DATABASE_URL not set. Run from backend/ with .env loaded.");
    process.exit(1);
  }

  const skus = parseSkusFromCli();
  const prefix = argValue("--prefix");

  if (skus.length === 0 && !prefix) {
    console.error(
      "❌ Provide at least one of: --skus \"SKU1,SKU2\", --file path.txt, or --prefix \"PREFIX-\""
    );
    process.exit(1);
  }

  const sql = postgres(DATABASE_URL, { prepare: false });

  const conditions: string[] = [];
  const params: any[] = [];
  if (skus.length > 0) {
    conditions.push(`sku = ANY($${params.length + 1}::text[])`);
    params.push(skus);
  }
  if (prefix) {
    conditions.push(`sku LIKE $${params.length + 1} || '%'`);
    params.push(prefix);
  }
  const whereClause = conditions.join(" OR ");

  const selectQuery = `
    SELECT id, sku, metadata
    FROM product_variant
    WHERE (${whereClause})
      AND deleted_at IS NULL
    ORDER BY sku
  `;

  const rows = await sql.unsafe<
    { id: string; sku: string | null; metadata: any }[]
  >(selectQuery, params);

  if (rows.length === 0) {
    console.log("ℹ️  No variants matched the filter.");
    await sql.end();
    return;
  }

  console.log(
    `${DRY_RUN ? "[DRY RUN] " : ""}Found ${rows.length} variant(s) matching filter:`
  );
  const toUpdate: { id: string; sku: string | null; prev: any }[] = [];
  for (const v of rows) {
    const meta = v.metadata || {};
    const current =
      meta.quickbooks_is_service === true ||
      meta.quickbooks_is_service === "true";
    const wants = !UNFLAG;
    const changes = current !== wants;
    console.log(
      `  • ${v.sku || "(no-sku)"}  ${v.id}  is_service=${current}  →  ${wants}${changes ? "" : "  (no-op)"}`
    );
    if (changes) toUpdate.push({ id: v.id, sku: v.sku, prev: meta });
  }

  if (toUpdate.length === 0) {
    console.log("✅ Nothing to change.");
    await sql.end();
    return;
  }

  if (DRY_RUN) {
    console.log(
      `\n[DRY RUN] Would ${UNFLAG ? "unflag" : "flag"} ${toUpdate.length} variant(s). Re-run with --execute to apply.`
    );
    await sql.end();
    return;
  }

  const ids = toUpdate.map((v) => v.id);
  if (UNFLAG) {
    await sql.unsafe(
      `UPDATE product_variant
       SET metadata = COALESCE(metadata, '{}'::jsonb) - 'quickbooks_is_service',
           updated_at = NOW()
       WHERE id = ANY($1::text[])`,
      [ids]
    );
  } else {
    await sql.unsafe(
      `UPDATE product_variant
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"quickbooks_is_service": true}'::jsonb,
           updated_at = NOW()
       WHERE id = ANY($1::text[])`,
      [ids]
    );
  }

  console.log(
    `\n✅ ${UNFLAG ? "Unflagged" : "Flagged"} ${toUpdate.length} variant(s) as QB service items.`
  );

  await sql.end();
}

main().catch(async (err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
