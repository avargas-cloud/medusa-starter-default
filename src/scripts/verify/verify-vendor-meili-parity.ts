/**
 * src/scripts/verify/verify-vendor-meili-parity.ts
 *
 * Read-only audit of the MeiliSearch `vendors` index against `qb_vendor` — the
 * index behind `searchVendors` (Factory Order manufacturer picker, PO vendor
 * picker).
 *
 * Checks TWO things, and the second one used to be missing:
 *   1. Presence — a vendor in Postgres and not in Meili is INVISIBLE in those
 *      pickers. 20 were missing when the trigger work started.
 *   2. CONTENT, field by field. Presence alone gives a false green: the orders
 *      index taught this on 2026-07-29, when all 1516 documents were present and
 *      freshly timestamped while their FIELDS were wrong. A vendor whose
 *      `full_name` or `payment_terms` is stale is findable and wrong, which is
 *      worse than missing.
 *
 * Single-sourced on purpose: the field list is `vendorReconciler.comparableFields`
 * and the expected doc comes from `transformVendor`, the same mapping the
 * single-vendor workflow and the bulk sync write through. A second field list or a
 * second mapping here would drift away from what a re-sync actually produces, and
 * then this script and the 5-minute sweep would disagree about what "drift" means.
 *
 * Uses ONE bulk list rather than a retrieve per vendor. Measured 2026-07-29:
 * ~2.67ms per vendor with Postgres and Meili co-located, but ~342ms each from a
 * dev laptop against Railway — over 1109 vendors that is 3 seconds versus 6 minutes.
 *
 * Usage (env must be explicit — the Avernuz shell leaks a wrong DATABASE_URL):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *       MEILISEARCH_HOST=$(grep ^MEILISEARCH_HOST= .env|cut -d= -f2-) \
 *       MEILISEARCH_API_KEY=$(grep ^MEILISEARCH_API_KEY= .env|cut -d= -f2-) \
 *       ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-vendor-meili-parity.ts
 *
 * Exits non-zero on missing, orphaned, or drifted vendors.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

// Generic value comparison, not orders-specific despite where it lives: it exists
// so a string/number round trip or ""-vs-null is not reported as drift. If a third
// consumer appears, move it to its own module.
import { sameIndexedValue } from "../../lib/meilisearch/audit-orders-index";
import { vendorReconciler } from "../../lib/meilisearch/reconcilers/vendor-reconciler";
import { transformVendor, VENDORS_INDEX } from "../../lib/meilisearch/vendor-doc";
import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";
import type QuickbooksCatalogModuleService from "../../modules/quickbooks-catalog/service";

interface VendorRow {
  id: string;
  full_name?: string | null;
  sync_status?: string | null;
  created_at?: Date | string | null;
}

type Doc = Record<string, unknown>;

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const { MeiliSearch } = await import("meilisearch");

  const AUDITED = vendorReconciler.comparableFields;

  const service = container.resolve(
    QUICKBOOKS_CATALOG_MODULE
  ) as unknown as QuickbooksCatalogModuleService;

  const vendors = (await service.listQbVendors(
    {},
    { take: 100000 }
  )) as unknown as VendorRow[];

  const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });
  const index = client.index(VENDORS_INDEX);

  // getDocuments().total is the accurate count — search's estimatedTotalHits
  // is capped by the index's maxTotalHits setting and lies above it.
  const docs = await index.getDocuments<Doc>({
    limit: 100000,
    fields: ["id", ...AUDITED],
  });
  const byId = new Map<string, Doc>(docs.results.map((d) => [String(d.id), d]));

  const missing: VendorRow[] = [];
  const driftByField = new Map<
    string,
    Array<{ id: string; name: string; want: unknown; got: unknown }>
  >();
  let driftedDocs = 0;

  for (const vendor of vendors) {
    const actual = byId.get(vendor.id);
    if (!actual) {
      missing.push(vendor);
      continue;
    }

    const expected = transformVendor(vendor as never) as unknown as Doc;
    let rowDrifted = false;
    for (const field of AUDITED) {
      if (sameIndexedValue(expected[field], actual[field])) continue;
      rowDrifted = true;
      const list = driftByField.get(field) ?? [];
      list.push({
        id: vendor.id,
        name: vendor.full_name ?? "(no name)",
        want: expected[field],
        got: actual[field],
      });
      driftByField.set(field, list);
    }
    if (rowDrifted) driftedDocs += 1;
  }

  const ids = new Set(vendors.map((v) => v.id));
  const orphans = [...byId.keys()].filter((id) => !ids.has(id));

  console.log(`\nAudit of the "${VENDORS_INDEX}" index\n`);
  console.log(`  qb_vendor rows         : ${vendors.length}`);
  console.log(`  documents in the index : ${docs.total}`);
  console.log(`  missing from the index : ${missing.length}`);
  console.log(`  orphaned in the index  : ${orphans.length}`);
  console.log(`  documents with drift   : ${driftedDocs}`);
  console.log(`  fields audited         : ${AUDITED.length}\n`);

  if (missing.length > 0) {
    console.log("  missing vendors (invisible in every vendor picker):");
    for (const v of missing) {
      const created =
        v.created_at instanceof Date
          ? v.created_at.toISOString().slice(0, 10)
          : String(v.created_at ?? "").slice(0, 10);
      console.log(
        `    ${v.id}  ${v.full_name ?? "(no name)"}  [${v.sync_status ?? "-"}]  ${created}`
      );
    }
    console.log();
  }

  if (orphans.length > 0) {
    // No reconciler can ever heal these: fetchUpdatedIdsSince reads the database,
    // and an orphan has no row there. They need a manual delete or a reindex.
    console.log("  orphaned docs (in Meili, gone from the database — no sweep heals these):");
    for (const id of orphans) console.log(`    ${id}`);
    console.log();
  }

  if (driftByField.size === 0) {
    console.log("  every audited field matches the database.\n");
  } else {
    console.log("  drift by field (worst first):\n");
    for (const [field, rows] of [...driftByField].sort(
      (a, b) => b[1].length - a[1].length
    )) {
      console.log(`    ${String(rows.length).padStart(5)} × ${field}`);
      for (const r of rows.slice(0, 3)) {
        console.log(
          `            ${r.name}: database says ${JSON.stringify(r.want)}, index says ${JSON.stringify(r.got)}`
        );
      }
      if (rows.length > 3) console.log(`            … and ${rows.length - 3} more`);
    }
    console.log();
  }

  const clean = missing.length === 0 && orphans.length === 0 && driftedDocs === 0;
  console.log(
    clean
      ? "OK — every vendor is searchable and every audited field matches.\n"
      : "DRIFT — re-run sync-vendors-meilisearch, then find out why it drifted.\n"
  );

  if (!clean) process.exitCode = 1;
}
