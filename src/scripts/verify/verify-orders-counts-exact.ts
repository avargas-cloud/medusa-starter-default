/**
 * Verifies that the POS /orders tab badges report EXACT counts, with no
 * ceiling.
 *
 * The bug this guards: /admin/orders/counts used index.search() and read
 * estimatedTotalHits, which MeiliSearch clamps to pagination.maxTotalHits
 * (default 1000, and still 1000 on the `orders` index). The All and Closed
 * badges therefore sat frozen at exactly 1000 while the real populations were
 * 1210 and 1193. The documents endpoint's `total` has no such ceiling.
 *
 * This script asserts, against the live index:
 *   1. every tab count read the exact way is >= the clamped way;
 *   2. at least one population exceeds the clamp, i.e. the ceiling is really
 *      gone rather than merely untested (skipped with a warning if the whole
 *      corpus is still under it);
 *   3. the tab sets partition coherently (visible + cancelled = all non-draft);
 *   4. the per-rep counts sum to the unfiltered total, so the rep filter the
 *      badges now apply neither drops nor double-counts an order.
 *
 * Read-only: issues search/document-fetch calls and nothing else.
 *
 * Usage:
 *   env $(grep -E '^MEILISEARCH_(HOST|API_KEY)=' .env | xargs) \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-orders-counts-exact.ts
 */

const ORDERS_INDEX = "orders";

const HOST = process.env.MEILISEARCH_HOST;
const KEY = process.env.MEILISEARCH_API_KEY;

const BASE = ["is_draft = false"];
const VISIBLE = [...BASE, "is_canceled = false", "is_voided = false"];

const TABS: Record<string, string[]> = {
  open: ["is_open = true"],
  closed: ["is_closed = true"],
  unpaid: ["is_unpaid = true"],
  web: ["is_web = true"],
  separated: ["is_separated = true"],
};

let failures = 0;

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${HOST}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** The exact count, the way the route now reads it. */
async function exact(filter: string[]): Promise<number> {
  const body = await call(`/indexes/${ORDERS_INDEX}/documents/fetch`, {
    limit: 0,
    filter,
  });
  return Number(body.total ?? 0);
}

/** The clamped count, the way the route used to read it. */
async function clamped(filter: string[]): Promise<number> {
  const body = await call(`/indexes/${ORDERS_INDEX}/search`, {
    q: "",
    limit: 0,
    filter,
  });
  return Number(body.estimatedTotalHits ?? 0);
}

async function maxTotalHits(): Promise<number> {
  const res = await fetch(
    `${HOST}/indexes/${ORDERS_INDEX}/settings/pagination`,
    { headers: { Authorization: `Bearer ${KEY}` } }
  );
  const body = (await res.json()) as { maxTotalHits?: number };
  return Number(body.maxTotalHits ?? 1000);
}

async function repCounts(): Promise<Record<string, number>> {
  const body = await call(`/indexes/${ORDERS_INDEX}/search`, {
    q: "",
    limit: 0,
    facets: ["sales_rep_initials"],
    filter: VISIBLE,
  });
  const dist = (body.facetDistribution as Record<string, Record<string, number>>)
    ?.sales_rep_initials;
  return dist ?? {};
}

async function main(): Promise<void> {
  if (!HOST || !KEY) {
    console.error("MEILISEARCH_HOST / MEILISEARCH_API_KEY are required.");
    process.exit(2);
  }

  const cap = await maxTotalHits();
  console.log(`\nIndex "${ORDERS_INDEX}" · pagination.maxTotalHits = ${cap}\n`);

  console.log("1 · exact vs clamped, per tab");
  const all = await exact(VISIBLE);
  const allClamped = await clamped(VISIBLE);
  check(
    `all = ${all}`,
    all >= allClamped,
    allClamped < all ? `search() would have reported ${allClamped}` : "under the cap"
  );

  let anyAboveCap = all > cap;
  for (const [tab, extra] of Object.entries(TABS)) {
    const filter = [...VISIBLE, ...extra];
    const e = await exact(filter);
    const c = await clamped(filter);
    anyAboveCap = anyAboveCap || e > cap;
    check(
      `${tab} = ${e}`,
      e >= c,
      c < e ? `search() would have reported ${c}` : "under the cap"
    );
  }

  console.log("\n2 · the ceiling is actually gone");
  if (anyAboveCap) {
    check("a population exceeds maxTotalHits and is still reported exactly", true, "");
  } else {
    console.log(
      `  WARN  every population is under ${cap}; the fix is untestable on this` +
        " dataset right now (it stays correct, it just proves nothing here)"
    );
  }

  console.log("\n3 · the tabs partition coherently");
  const cancelled = await exact([
    ...BASE,
    "(is_canceled = true OR is_voided = true)",
  ]);
  const nonDraft = await exact(BASE);
  check(
    "visible + cancelled = all non-draft",
    all + cancelled === nonDraft,
    `${all} + ${cancelled} = ${all + cancelled} vs ${nonDraft}`
  );

  console.log("\n4 · the rep filter neither drops nor double-counts");
  const reps = await repCounts();
  let repTotal = 0;
  for (const [rep, facetCount] of Object.entries(reps)) {
    const filtered = await exact([
      ...VISIBLE,
      `sales_rep_initials = "${rep}"`,
    ]);
    repTotal += filtered;
    check(
      `rep ${rep} = ${filtered}`,
      filtered === facetCount,
      filtered === facetCount ? "" : `facet says ${facetCount}`
    );
  }
  check(
    "per-rep counts sum to the unfiltered total",
    repTotal === all,
    `${repTotal} vs ${all}`
  );

  console.log(
    failures === 0
      ? "\nOK — every badge count is exact and uncapped.\n"
      : `\n${failures} check(s) FAILED.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
