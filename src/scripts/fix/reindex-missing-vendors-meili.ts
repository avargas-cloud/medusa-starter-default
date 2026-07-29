/**
 * src/scripts/fix/reindex-missing-vendors-meili.ts
 *
 * One-shot repair for vendors that exist in `qb_vendor` but are absent from
 * the MeiliSearch `vendors` index — i.e. invisible in the Factory Order
 * manufacturer picker and the PO vendor picker.
 *
 * Only the MISSING ids are upserted; the docs already in the index are left
 * untouched. Nothing is ever deleted here.
 *
 * Going forward the `trg_meili_sync_qb_vendor` trigger + the `vendor`
 * reconciler keep the index in sync automatically — this script exists for the
 * backlog that predates the trigger, and as a manual repair tool.
 *
 * Usage (dry-run by default):
 *   env DATABASE_URL=... MEILISEARCH_HOST=... MEILISEARCH_API_KEY=... \
 *       npx medusa exec ./src/scripts/fix/reindex-missing-vendors-meili.ts
 *   ...same with APPLY=true to actually write.
 */

import type { MedusaContainer } from "@medusajs/framework/types";

import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";
import type QuickbooksCatalogModuleService from "../../modules/quickbooks-catalog/service";
import {
  transformVendor,
  VENDORS_INDEX,
} from "../../lib/meilisearch/vendor-doc";

interface VendorRow {
  id: string;
  full_name?: string | null;
}

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const apply = process.env.APPLY === "true";

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

  const docs = await index.getDocuments({ limit: 100000, fields: ["id"] });
  const present = new Set((docs.results as { id: string }[]).map((d) => d.id));

  const missing = vendors.filter((v) => !present.has(v.id));

  console.log(`DB rows: ${vendors.length} · Meili docs: ${docs.total}`);
  console.log(`Missing (to upsert): ${missing.length}`);
  for (const v of missing) console.log(`  ${v.id}  ${v.full_name ?? ""}`);

  if (missing.length === 0) {
    console.log("\nNothing to do — index already has every vendor.");
    return;
  }

  if (!apply) {
    console.log("\nDRY RUN — re-run with APPLY=true to upsert these.");
    return;
  }

  const task = await index.addDocuments(missing.map(transformVendor), {
    primaryKey: "id",
  });
  await client.tasks.waitForTask(task.taskUid);

  const after = await index.getDocuments({ limit: 1, fields: ["id"] });
  console.log(`\n✅ Upserted ${missing.length}. Meili docs now: ${after.total}`);
}
