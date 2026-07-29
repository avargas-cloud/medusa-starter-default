/**
 * src/scripts/verify/verify-vendor-meili-parity.ts
 *
 * Read-only parity check between the `qb_vendor` table and the MeiliSearch
 * `vendors` index — the index that backs `searchVendors` (Factory Order
 * manufacturer picker, PO vendor picker).
 *
 * A vendor present in Postgres but absent from Meili is INVISIBLE in those
 * pickers, which is the exact failure this exists to catch.
 *
 * Usage (env must be explicit — the Avernuz shell leaks a wrong DATABASE_URL):
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env|cut -d= -f2-) \
 *       MEILISEARCH_HOST=$(grep ^MEILISEARCH_HOST= .env|cut -d= -f2-) \
 *       MEILISEARCH_API_KEY=$(grep ^MEILISEARCH_API_KEY= .env|cut -d= -f2-) \
 *       npx medusa exec ./src/scripts/verify/verify-vendor-meili-parity.ts
 *
 * Exits non-zero when the index is missing vendors.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";
import type QuickbooksCatalogModuleService from "../../modules/quickbooks-catalog/service";
import { VENDORS_INDEX } from "../../lib/meilisearch/vendor-doc";

interface VendorRow {
  id: string;
  full_name?: string | null;
  sync_status?: string | null;
  created_at?: Date | string | null;
}

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const { MeiliSearch } = await import("meilisearch");

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
  const docs = await index.getDocuments({ limit: 100000, fields: ["id"] });
  const meiliIds = new Set(
    (docs.results as { id: string }[]).map((d) => d.id)
  );

  const missing = vendors.filter((v) => !meiliIds.has(v.id));
  const orphans = [...meiliIds].filter(
    (id) => !vendors.some((v) => v.id === id)
  );

  console.log(`DB qb_vendor rows : ${vendors.length}`);
  console.log(`Meili vendors docs: ${docs.total}`);
  console.log(`Missing from Meili: ${missing.length}`);
  console.log(`Orphan Meili docs : ${orphans.length}`);

  if (missing.length > 0) {
    console.log("\nMissing vendors (invisible in every vendor picker):");
    for (const v of missing) {
      const created =
        v.created_at instanceof Date
          ? v.created_at.toISOString().slice(0, 10)
          : String(v.created_at ?? "").slice(0, 10);
      console.log(
        `  ${v.id}  ${v.full_name ?? "(no name)"}  [${v.sync_status ?? "-"}]  ${created}`
      );
    }
  }

  if (orphans.length > 0) {
    console.log("\nOrphan docs (in Meili, gone from DB):");
    for (const id of orphans) console.log(`  ${id}`);
  }

  if (missing.length === 0 && orphans.length === 0) {
    console.log("\n✅ Parity OK — every vendor is searchable.");
    return;
  }

  process.exitCode = 1;
}
