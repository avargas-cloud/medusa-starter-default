/**
 * Re-syncs customers that exist in the database and have no document in the
 * `customers` index, so they become searchable again.
 *
 * Why these need a script at all: the 5-minute reconciliation sweep enumerates
 * rows by `updated_at` inside a 6-minute window, and the four found on 2026-07-29
 * were last touched on 2026-05-01. Nothing will ever put them in that window, so
 * fixing the sweep's missing-document detection (see drift-reconciler.ts) makes it
 * capable going forward but cannot reach this backlog.
 *
 * They were invisible in customer search for three months because the sweep's 404
 * check tested a property the Meili client does not set.
 *
 * DRY RUN BY DEFAULT. It prints exactly which customers it would write and stops.
 * Pass APPLY=true to write. Writes to MeiliSearch only — never to Postgres.
 *
 *   env DATABASE_URL=... MEILISEARCH_HOST=... MEILISEARCH_API_KEY=... \
 *     ./node_modules/.bin/medusa exec ./src/scripts/fix/resync-missing-customer-docs.ts
 *
 *   ... APPLY=true ./node_modules/.bin/medusa exec ./src/scripts/fix/resync-missing-customer-docs.ts
 *
 * Idempotent: re-running writes the same documents. It only ever ADDS documents
 * that the database says should exist — it never deletes. Orphans (a document with
 * no row behind it) are deliberately out of scope: deleting is not reversible by
 * re-running, and no sweep can create them by accident either.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import postgres from "postgres";

import { isIndexNotFound } from "../../lib/meilisearch/meili-errors";
import { syncCustomerToMeili } from "../../lib/meilisearch/sync-customer";

const CUSTOMERS_INDEX = "customers";

export default async function run({ container }: ExecArgs): Promise<void> {
  const apply = process.env.APPLY === "true";
  const dbUrl = process.env.DATABASE_URL;
  const host = process.env.MEILISEARCH_HOST;

  if (!dbUrl || !host || !process.env.MEILISEARCH_API_KEY) {
    console.error("DATABASE_URL, MEILISEARCH_HOST and MEILISEARCH_API_KEY must all be set.");
    process.exit(2);
  }

  const { MeiliSearch } = await import("meilisearch");
  const index = new MeiliSearch({
    host,
    apiKey: process.env.MEILISEARCH_API_KEY,
  }).index(CUSTOMERS_INDEX);

  // Every id the index holds. Compared as SETS rather than by count: a count
  // match hides a missing document sitting behind an orphan, which is how the
  // orders index looked healthy while its fields were wrong.
  const indexed = new Set<string>();
  let offset = 0;
  const PAGE = 1000;
  try {
    for (;;) {
      const page = await index.getDocuments<{ id: string }>({
        limit: PAGE,
        offset,
        fields: ["id"],
      });
      for (const d of page.results) indexed.add(String(d.id));
      if (page.results.length < PAGE) break;
      offset += PAGE;
    }
  } catch (err: unknown) {
    if (isIndexNotFound(err)) {
      throw new Error(
        `the "${CUSTOMERS_INDEX}" index does not exist on ${host} — build it first ` +
          `instead of adding documents one at a time`
      );
    }
    throw err;
  }

  const sql = postgres(dbUrl, { max: 2 });
  let missing: Array<{ id: string; email: string | null; updated_at: Date }>;
  try {
    const rows = await sql<Array<{ id: string; email: string | null; updated_at: Date }>>`
      SELECT id, email, updated_at
      FROM customer
      WHERE deleted_at IS NULL
      ORDER BY updated_at
    `;
    missing = rows.filter((r) => !indexed.has(r.id));
  } finally {
    await sql.end();
  }

  console.log(`\nCustomers with no document in "${CUSTOMERS_INDEX}"\n`);
  console.log(`  documents in the index : ${indexed.size}`);
  console.log(`  missing                : ${missing.length}`);
  console.log(`  mode                   : ${apply ? "APPLY" : "DRY RUN"}\n`);

  if (missing.length === 0) {
    console.log("  nothing to do — every customer has a document.\n");
    return;
  }

  for (const c of missing) {
    console.log(
      `    ${c.id}  ${c.email ?? "(no email)"}  last touched ${c.updated_at.toISOString().slice(0, 10)}`
    );
  }
  console.log();

  if (!apply) {
    console.log("  DRY RUN — nothing was written. Re-run with APPLY=true to sync these.\n");
    return;
  }

  let synced = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const c of missing) {
    try {
      await syncCustomerToMeili(c.id, container);
      synced += 1;
      console.log(`    synced ${c.id}`);
    } catch (err: unknown) {
      failures.push({ id: c.id, error: (err as Error).message });
      console.error(`    FAILED ${c.id}: ${(err as Error).message}`);
    }
  }

  console.log(`\n  synced ${synced}/${missing.length}\n`);

  // Read back rather than trusting the writes: the point of the exercise is that
  // the document EXISTS, and a task Meili accepted is not a task Meili finished.
  await new Promise((r) => setTimeout(r, 3000));
  const stillMissing: string[] = [];
  for (const c of missing) {
    try {
      await index.getDocument(c.id, { fields: ["id"] });
    } catch {
      stillMissing.push(c.id);
    }
  }

  if (stillMissing.length > 0 || failures.length > 0) {
    console.error(
      `  NOT CLEAN — ${failures.length} write error(s), ${stillMissing.length} still absent after the write.\n`
    );
    process.exitCode = 1;
    return;
  }
  console.log("  verified — every one of them now has a document.\n");
}
