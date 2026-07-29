/**
 * Audits the `orders` MeiliSearch index against the database, field by field.
 *
 * Orders are the ONE important entity whose index sync depends entirely on some
 * route remembering to emit an event. Everything else — products, variants,
 * customers, inventory levels, reservations, vendors, POs, FOs — has a Postgres
 * trigger feeding `meili_sync_queue` and a reconciler draining it. On 2026-07-29
 * that gap cost ~900 wrong documents: a finance route moved money and emitted
 * nothing, and nothing anywhere would have noticed.
 *
 * Counting documents or comparing timestamps would NOT have caught it. Every
 * document was present and every timestamp was fresh; the FIELDS were wrong. So
 * this rebuilds the doc each order should have — through buildAllOrderDocs, the
 * same path the sync uses, so a difference in fetching cannot invent drift — and
 * diffs it against what the index actually holds.
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
  ORDERS_INDEX,
  buildAllOrderDocs,
} from "../../lib/meilisearch/sync-orders-runner";

/** Fields whose drift changes what the operator sees or which tab an order is in. */
const AUDITED_FIELDS = [
  "display_id",
  "document_number",
  "status",
  "effective_payment",
  "fulfillment_status",
  "is_unpaid",
  "is_open",
  "is_closed",
  "is_separated",
  "is_canceled",
  "is_voided",
  "is_web",
  "is_draft",
  "total_cents",
  "sales_rep_initials",
  "effective_date_ts",
] as const;

type Doc = Record<string, unknown>;

/** Same value, allowing for the string/number sloppiness money survives as. */
function same(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (typeof expected === "number" || typeof actual === "number") {
    const a = Number(expected);
    const b = Number(actual);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < 0.01;
  }
  // "" and null/undefined both mean "the index has nothing here".
  const empty = (v: unknown) => v === "" || v === null || v === undefined;
  return empty(expected) && empty(actual);
}

async function fetchIndexedDocs(): Promise<Map<string, Doc>> {
  const { MeiliSearch } = await import("meilisearch");
  const meili = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });
  const index = meili.index(ORDERS_INDEX);

  const byId = new Map<string, Doc>();
  let offset = 0;
  const PAGE = 1000;
  for (;;) {
    const page = await index.getDocuments<Doc>({
      limit: PAGE,
      offset,
      fields: ["id", ...AUDITED_FIELDS] as string[],
    });
    for (const doc of page.results) byId.set(String(doc.id), doc);
    if (page.results.length < PAGE) break;
    offset += PAGE;
  }
  return byId;
}

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const logger = container.resolve("logger") as { info: (m: string) => void };

  const [expectedDocs, indexed] = await Promise.all([
    buildAllOrderDocs(container),
    fetchIndexedDocs(),
  ]);

  const missing: number[] = [];
  const byField = new Map<string, Array<{ id: number; want: unknown; got: unknown }>>();
  let drifted = 0;

  for (const expected of expectedDocs as unknown as Doc[]) {
    const actual = indexed.get(String(expected.id));
    if (!actual) {
      missing.push(Number(expected.display_id));
      continue;
    }
    let rowDrifted = false;
    for (const field of AUDITED_FIELDS) {
      if (!same(expected[field], actual[field])) {
        rowDrifted = true;
        const list = byField.get(field) ?? [];
        list.push({
          id: Number(expected.display_id),
          want: expected[field],
          got: actual[field],
        });
        byField.set(field, list);
      }
    }
    if (rowDrifted) drifted += 1;
  }

  const expectedIds = new Set(
    (expectedDocs as unknown as Doc[]).map((d) => String(d.id))
  );
  const orphans = [...indexed.keys()].filter((id) => !expectedIds.has(id));

  console.log(`\nAudit of the "${ORDERS_INDEX}" index\n`);
  console.log(`  orders in the database : ${expectedDocs.length}`);
  console.log(`  documents in the index : ${indexed.size}`);
  console.log(`  missing from the index : ${missing.length}${
    missing.length ? ` — #${missing.slice(0, 15).join(", #")}` : ""
  }`);
  console.log(`  orphaned in the index  : ${orphans.length}${
    orphans.length ? ` — ${orphans.slice(0, 5).join(", ")}` : ""
  }`);
  console.log(`  documents with drift   : ${drifted}\n`);

  if (byField.size === 0) {
    console.log("  every audited field matches the database.\n");
  } else {
    console.log("  drift by field (worst first):\n");
    for (const [field, rows] of [...byField].sort(
      (a, b) => b[1].length - a[1].length
    )) {
      console.log(`    ${String(rows.length).padStart(5)} × ${field}`);
      for (const r of rows.slice(0, 3)) {
        console.log(
          `            #${r.id}: database says ${JSON.stringify(r.want)}, index says ${JSON.stringify(r.got)}`
        );
      }
      if (rows.length > 3) console.log(`            … and ${rows.length - 3} more`);
    }
    console.log();
  }

  const clean = drifted === 0 && missing.length === 0 && orphans.length === 0;
  console.log(
    clean
      ? "OK — the index agrees with the database.\n"
      : "DRIFT — re-run sync-meili-orders, then investigate why it drifted.\n"
  );
  logger.info(
    `[meili-orders-integrity] drifted=${drifted} missing=${missing.length} orphans=${orphans.length}`
  );
  process.exit(clean ? 0 : 1);
}
