/**
 * Prints the `orders` index audit and exits non-zero on drift.
 *
 * All of the comparison lives in lib/meilisearch/audit-orders-index.ts, which the
 * daily digest calls too. This file is a printer: no field list, no equality
 * rule, no fetching of its own. A second copy of any of those would rot away from
 * the one the digest uses, and a drift detector that disagrees with itself is
 * worse than none.
 *
 * Read-only. Writes nothing to Postgres or MeiliSearch.
 *
 * Usage:
 *   cd backend && env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     MEILISEARCH_HOST=$(grep ^MEILISEARCH_HOST= .env | cut -d= -f2-) \
 *     MEILISEARCH_API_KEY=$(grep ^MEILISEARCH_API_KEY= .env | cut -d= -f2-) \
 *     yarn medusa exec ./src/scripts/verify/verify-meili-orders-integrity.ts
 *
 * Exit codes: 0 in sync · 1 drift found · 2 could not run.
 */
import type { MedusaContainer } from "@medusajs/framework/types";

import {
  auditOrdersIndex,
  groupDriftsByField,
} from "../../lib/meilisearch/audit-orders-index";
import { ORDERS_INDEX } from "../../lib/meilisearch/sync-orders-runner";

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const logger = container.resolve("logger") as { info: (m: string) => void };

  const result = await auditOrdersIndex(container);

  const missingLabel = result.missing
    .slice(0, 15)
    .map((m) => `#${m.display_id ?? m.order_id}`)
    .join(", ");

  console.log(`\nAudit of the "${ORDERS_INDEX}" index\n`);
  console.log(`  orders in the database : ${result.ordersInDb}`);
  console.log(`  documents in the index : ${result.docsInIndex}`);
  console.log(
    `  missing from the index : ${result.missing.length}${
      result.missing.length ? ` — ${missingLabel}` : ""
    }`
  );
  console.log(
    `  orphaned in the index  : ${result.orphans.length}${
      result.orphans.length ? ` — ${result.orphans.slice(0, 5).join(", ")}` : ""
    }`
  );
  console.log(`  documents with drift   : ${result.driftedDocs}\n`);

  const byField = groupDriftsByField(result.drifts);
  if (byField.length === 0) {
    console.log("  every audited field matches the database.\n");
  } else {
    console.log("  drift by field (worst first):\n");
    for (const { field, rows } of byField) {
      console.log(`    ${String(rows.length).padStart(5)} × ${field}`);
      for (const r of rows.slice(0, 3)) {
        console.log(
          `            #${r.display_id ?? r.order_id}: database says ${JSON.stringify(
            r.expected
          )}, index says ${JSON.stringify(r.actual)}`
        );
      }
      if (rows.length > 3) console.log(`            … and ${rows.length - 3} more`);
    }
    console.log();
  }

  console.log(
    result.clean
      ? "OK — the index agrees with the database.\n"
      : "DRIFT — re-run sync-meili-orders, then investigate why it drifted.\n"
  );
  logger.info(
    `[meili-orders-integrity] drifted=${result.driftedDocs} missing=${result.missing.length} orphans=${result.orphans.length}`
  );
  process.exit(result.clean ? 0 : 1);
}
