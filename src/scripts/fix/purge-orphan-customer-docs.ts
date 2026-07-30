/**
 * Removes `customers` index documents for customers that should not be searchable:
 * the row is soft-deleted, or there is no row at all.
 *
 * Three of these were found on 2026-07-29, soft-deleted since 2026-05-01 and still
 * findable in customer search. The leak that produced them is fixed in
 * sync-customer.ts (a gone customer now loses its document), but that only helps
 * from now on: the reconciliation sweep enumerates rows with
 * `WHERE deleted_at IS NULL`, so a soft-deleted row is never enumerated and its
 * stale document is never revisited. This drains the backlog.
 *
 * EXPORTS BEFORE DELETING, always, including in dry run. These documents cannot be
 * regenerated — a reindex builds from the database and the database is exactly what
 * does not have them — so the delete is a one-way door and the export is the only
 * way back. Path via ORPHAN_EXPORT (default /tmp/orphan-customer-docs-<index>.json).
 *
 * DRY RUN BY DEFAULT. APPLY=true to delete.
 *
 *   env DATABASE_URL=... MEILISEARCH_HOST=... MEILISEARCH_API_KEY=... \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/purge-orphan-customer-docs.ts
 *
 * NEVER deletes a document whose customer is alive. That is the one property worth
 * guarding: a stale document is a nuisance, a deleted live customer is invisible
 * inventory of the sales pipeline. The guard is mutation-tested — remove it and the
 * plan should immediately include live customers.
 */
import { writeFileSync } from "fs";

import type { ExecArgs } from "@medusajs/framework/types";
import postgres from "postgres";

import { isIndexNotFound } from "../../lib/meilisearch/meili-errors";

const CUSTOMERS_INDEX = "customers";

type Doc = Record<string, unknown>;

export default async function run(_args: ExecArgs): Promise<void> {
  const apply = process.env.APPLY === "true";
  const dbUrl = process.env.DATABASE_URL;
  const host = process.env.MEILISEARCH_HOST;
  if (!dbUrl || !host || !process.env.MEILISEARCH_API_KEY) {
    console.error("DATABASE_URL, MEILISEARCH_HOST and MEILISEARCH_API_KEY must all be set.");
    process.exit(2);
  }
  const exportPath =
    process.env.ORPHAN_EXPORT ??
    `/tmp/orphan-customer-docs-${new URL(host).host.replace(/[^a-z0-9]/gi, "_")}.json`;

  const { MeiliSearch } = await import("meilisearch");
  const index = new MeiliSearch({
    host,
    apiKey: process.env.MEILISEARCH_API_KEY,
  }).index(CUSTOMERS_INDEX);

  // Whole documents, not just ids: the export has to be enough to put one back.
  const docs: Doc[] = [];
  let offset = 0;
  const PAGE = 1000;
  try {
    for (;;) {
      const page = await index.getDocuments<Doc>({ limit: PAGE, offset });
      docs.push(...page.results);
      if (page.results.length < PAGE) break;
      offset += PAGE;
    }
  } catch (err: unknown) {
    if (isIndexNotFound(err)) {
      throw new Error(`the "${CUSTOMERS_INDEX}" index does not exist on ${host}`);
    }
    throw err;
  }

  const sql = postgres(dbUrl, { max: 2 });
  let live: Set<string>;
  let softDeleted: Set<string>;
  try {
    const rows = await sql<Array<{ id: string; deleted: boolean }>>`
      SELECT id, deleted_at IS NOT NULL AS deleted FROM customer
    `;
    live = new Set(rows.filter((r) => !r.deleted).map((r) => r.id));
    softDeleted = new Set(rows.filter((r) => r.deleted).map((r) => r.id));
  } finally {
    await sql.end();
  }

  const classify = (id: string) =>
    live.has(id) ? "live" : softDeleted.has(id) ? "soft-deleted" : "no row at all";

  const orphans = docs.filter((d) => !live.has(String(d.id)));

  console.log(`\nOrphan documents in "${CUSTOMERS_INDEX}"\n`);
  console.log(`  documents in the index : ${docs.length}`);
  console.log(`  live customers         : ${live.size}`);
  console.log(`  soft-deleted customers : ${softDeleted.size}`);
  console.log(`  orphan documents       : ${orphans.length}`);
  console.log(`  mode                   : ${apply ? "APPLY" : "DRY RUN"}\n`);

  // Export unconditionally, before any delete. A dry run that does not leave the
  // safety net behind is not a rehearsal of the real thing.
  writeFileSync(exportPath, JSON.stringify(orphans, null, 2), "utf8");
  console.log(`  exported ${orphans.length} document(s) → ${exportPath}\n`);

  if (orphans.length === 0) {
    console.log("  nothing to do — every document belongs to a live customer.\n");
    return;
  }

  for (const d of orphans) {
    const id = String(d.id);
    console.log(`    ${id}  ${String(d.email ?? "(no email)")}  [${classify(id)}]`);
  }
  console.log();

  // The guard. A live customer must never be in this set; if one is, the predicate
  // is wrong and deleting would remove a findable customer from search.
  const wouldDeleteLive = orphans.filter((d) => live.has(String(d.id)));
  if (wouldDeleteLive.length > 0) {
    console.error(
      `  ABORTING — ${wouldDeleteLive.length} of these belong to LIVE customers. ` +
        `The predicate is wrong; nothing was deleted.\n`
    );
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log("  DRY RUN — nothing was deleted. Re-run with APPLY=true.\n");
    return;
  }

  const ids = orphans.map((d) => String(d.id));
  await index.deleteDocuments(ids);
  await new Promise((r) => setTimeout(r, 3000));

  // Read back: a task Meili accepted is not a task Meili finished.
  const survivors: string[] = [];
  for (const id of ids) {
    try {
      await index.getDocument(id, { fields: ["id"] });
      survivors.push(id);
    } catch {
      /* gone, as intended */
    }
  }

  console.log(`  deleted ${ids.length - survivors.length}/${ids.length}\n`);
  if (survivors.length > 0) {
    console.error(`  NOT CLEAN — still present: ${survivors.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`  verified — all gone. Restore from ${exportPath} if this was wrong.\n`);
}
