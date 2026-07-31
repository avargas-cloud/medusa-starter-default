/**
 * Asserts that /admin/orders/filter and /admin/orders/search describe the same
 * order the same way.
 *
 * They are sibling routes over the same population — the POS swaps between them
 * by tab — and on 2026-07-31 they disagreed. search hydrated through
 * query.graph asking for `payment_status` and `fulfillment_status`, which
 * Medusa computes rather than stores: query.graph returns neither and raises
 * nothing. The FULFILLMENT column went blank while searching, and the QB REF
 * cell, whose fallback reads exactly those two fields, printed "Missing in QB"
 * over healthy orders. S11296 (qb_sync_status "synced") read "Invoiced" on the
 * list and "Missing in QB" the moment you searched for it.
 *
 * A type-check cannot catch that class of bug — the fields are declared, they
 * just never arrive — so this compares the live answers, field by field.
 *
 * Run it as a plain script, NOT through `medusa exec`: it has no default export
 * and needs no container, it only makes HTTP calls.
 *
 *   ADMIN_JWT=<token> BASE_URL=http://localhost:9090 \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-orders-search-filter-parity.ts
 *
 * Exit 0 = the two routes agree. Exit 1 = they do not, and it names the fields.
 */

import fs from "node:fs";
import path from "node:path";
import { PROJECTED_METADATA_KEYS } from "../../api/admin/orders/_lib/hydrate-order-rows";

const BASE_URL = (process.env.BASE_URL || "http://localhost:9090").replace(
  /\/$/,
  ""
);
const ADMIN_JWT =
  process.env.ADMIN_JWT ||
  (process.env.ADMIN_JWT_FILE
    ? fs.readFileSync(process.env.ADMIN_JWT_FILE, "utf8").trim()
    : "");
const POS_SALES_CHANNEL_ID = process.env.POS_SALES_CHANNEL_ID || "";

// Prefix terms rather than one search per order: the index matches
// document_number, so a handful of requests compares most of the population.
// Every order that any of them returns is compared.
const SEARCH_TERMS = (
  process.env.SEARCH_TERMS || "S9,S10,S11,S12,S13,S11296,S11045"
).split(",");

// Must agree by both routes no matter what else changes. S11296 is the case
// that reproduced the bug (synced, delivered, but blank via search). S11045 is
// the control: its qb_sync_status is "child_synced", which short-circuits the
// QB REF cell before fulfillment_status is consulted, so it read "Invoiced"
// both ways even while broken — it proves the assert is not passing by accident.
const NOMINAL_DOCS = (process.env.NOMINAL_DOCS || "S11296,S11045").split(",");

const STORE_POS_LIST_SOURCES = [
  "store-pos/app/(pos)/orders/components/OrderTableRow.tsx",
  "store-pos/app/(pos)/orders/utils.ts",
  "store-pos/app/(pos)/orders/hooks/useOrdersList.ts",
];

interface OrderRow {
  id: string;
  display_id?: number;
  status?: string;
  email?: string | null;
  created_at?: string;
  payment_status?: string;
  fulfillment_status?: string;
  total?: number | null;
  metadata?: Record<string, unknown> | null;
  summary?: Record<string, unknown> | null;
  customer?: Record<string, unknown> | null;
  billing_address?: Record<string, unknown> | null;
  sales_channel?: { id?: string; name?: string } | null;
  payment_collections?: Array<Record<string, unknown>>;
  shipping_methods?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

const failures: string[] = [];
function fail(message: string): void {
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

async function get<T>(pathname: string): Promise<T> {
  const res = await fetch(BASE_URL + pathname, {
    headers: { Authorization: `Bearer ${ADMIN_JWT}` },
  });
  if (!res.ok) {
    throw new Error(
      `GET ${pathname} -> ${res.status} ${(await res.text()).slice(0, 300)}`
    );
  }
  return res.json() as Promise<T>;
}

/** Key order must not decide equality; a JSONB projection does not promise one. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        )
      );
    }
    return v;
  });
}

/**
 * The QB REF cell, transcribed from store-pos OrderTableRow.tsx:21-47.
 *
 * Comparing the two routes' raw fields would already catch the divergence, but
 * this is the thing the operator actually saw: an order that is fine in
 * QuickBooks accused of being missing from it. Asserting the rendered string
 * keeps the test anchored to the symptom rather than to the mechanism.
 */
function qbRefCell(o: OrderRow): string {
  const md = (o.metadata ?? {}) as Record<string, any>;
  let qbRef =
    md.qb_sales_order?.ref_number ??
    md.qb_sales_order_ref_num ??
    md.qb_invoice_ref_num ??
    "—";
  const so = md.qb_sales_order as { txn_id?: string } | undefined;
  const rawStatus = md.qb_sync_status as string | undefined;
  const isPosOrder =
    o.sales_channel?.id === POS_SALES_CHANNEL_ID || md.pos_created === true;
  const ageMs = Date.now() - new Date(o.created_at ?? 0).getTime();
  const isPendingCron =
    isPosOrder &&
    !so?.txn_id &&
    rawStatus !== "error" &&
    rawStatus !== "child_synced" &&
    rawStatus !== "synced" &&
    ageMs < 24 * 60 * 60 * 1000;
  const isSkippedFallback =
    isPosOrder &&
    !isPendingCron &&
    !so?.txn_id &&
    (o.payment_status === "captured" ||
      ["fulfilled", "shipped", "delivered"].includes(
        o.fulfillment_status ?? ""
      ) ||
      md.qb_invoice_ref_num != null ||
      (md.qb_invoice as { txn_id?: string } | undefined)?.txn_id != null);
  const isMissing =
    isPosOrder &&
    !isPendingCron &&
    !so?.txn_id &&
    !isSkippedFallback &&
    rawStatus !== "child_synced";
  if ((isSkippedFallback || rawStatus === "child_synced") && qbRef === "—") {
    qbRef = "Invoiced";
  } else if (isMissing && qbRef === "—") {
    qbRef = rawStatus === "error" ? "Sync Error" : "Missing in QB";
  }
  return String(qbRef);
}

/**
 * Every order.metadata key the POS list path reads, scraped from its source.
 *
 * Scraped rather than listed so it cannot rot: a key added to the POS and not
 * to the projection arrives undefined and the row silently renders a fallback.
 * That is exactly how computed_total — the figure getOrderTotal prefers above
 * all others — was missing for the 1,274 orders that carry it without a
 * pos_total.
 */
function metadataKeysReadByPos(repoRoot: string): string[] {
  const keys = new Set<string>();
  for (const rel of STORE_POS_LIST_SOURCES) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) {
      throw new Error(
        `Cannot read ${rel}. This check must run from the workspace so it can ` +
          `see what the POS actually reads; skipping it would make this script ` +
          `report a coverage it never verified.`
      );
    }
    // Comments first: these files explain themselves at length, and a sentence
    // ending in "…inconsistent metadata." followed by a line starting with `if`
    // reads as a property access to a regex that tolerates whitespace. It cost
    // one false failure. Nor is whitespace tolerated after the dot — real code
    // never writes `metadata?. key`.
    const src = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    for (const m of src.matchAll(/metadata\??\.([a-z_][a-z0-9_]*)/gi)) {
      keys.add(m[1]);
    }
    for (const m of src.matchAll(/metadata\??\.?\[\s*['"]([a-z_][a-z0-9_]*)['"]/gi)) {
      keys.add(m[1]);
    }
  }
  return [...keys].sort();
}

async function main(): Promise<void> {
  if (!ADMIN_JWT) {
    throw new Error("ADMIN_JWT (or ADMIN_JWT_FILE) is required.");
  }
  console.log(`Target: ${BASE_URL}\n`);

  // ---------------------------------------------------------------- static
  console.log("1. Projection covers every metadata key the POS list reads");
  const repoRoot = path.resolve(__dirname, "../../../..");
  const posKeys = metadataKeysReadByPos(repoRoot);
  const projected = new Set<string>(PROJECTED_METADATA_KEYS);
  const missing = posKeys.filter((k) => !projected.has(k));
  if (missing.length) {
    fail(
      `the POS reads ${missing.length} metadata key(s) the projection drops: ${missing.join(", ")}`
    );
  } else {
    console.log(
      `  ✓ ${posKeys.length} keys read, all projected (${projected.size} projected in total)`
    );
  }

  // ------------------------------------------------------------ population
  console.log("\n2. Loading the filter population");
  const filterRes = await get<{ orders: OrderRow[]; estimatedTotalHits: number }>(
    `/admin/orders/filter?tab=all&from=0&to=${Date.now()}&showCancelled=true`
  );
  const byIdFilter = new Map(filterRes.orders.map((o) => [o.id, o]));
  console.log(`  ✓ ${byIdFilter.size} orders from /filter?tab=all`);

  // --------------------------------------------------------- field parity
  console.log("\n3. Field-by-field parity on every order both routes return");
  const compared = new Map<string, OrderRow>();
  const diffsByField = new Map<string, number>();
  const examplesByField = new Map<string, string>();

  for (const term of SEARCH_TERMS) {
    const s = await get<{ orders: OrderRow[] }>(
      `/admin/orders/search?q=${encodeURIComponent(term)}&limit=200`
    );
    for (const searchRow of s.orders) {
      if (compared.has(searchRow.id)) continue;
      const filterRow = byIdFilter.get(searchRow.id);
      if (!filterRow) continue;
      compared.set(searchRow.id, searchRow);

      const keys = new Set([...Object.keys(filterRow), ...Object.keys(searchRow)]);
      for (const key of keys) {
        const a = stable(filterRow[key]);
        const b = stable(searchRow[key]);
        if (a === b) continue;
        diffsByField.set(key, (diffsByField.get(key) ?? 0) + 1);
        if (!examplesByField.has(key)) {
          const doc = (filterRow.metadata as any)?.document_number ?? filterRow.id;
          examplesByField.set(
            key,
            `${doc}: filter=${String(a).slice(0, 90)} search=${String(b).slice(0, 90)}`
          );
        }
      }
    }
  }

  console.log(
    `  compared ${compared.size} orders across ${SEARCH_TERMS.length} search terms`
  );
  if (compared.size === 0) {
    fail("compared 0 orders — the search terms matched nothing, so this proved nothing");
  }
  if (diffsByField.size === 0) {
    console.log("  ✓ every field identical on every compared order");
  } else {
    for (const [field, count] of [...diffsByField].sort((a, b) => b[1] - a[1])) {
      fail(`${field}: differs on ${count}/${compared.size} orders — ${examplesByField.get(field)}`);
    }
  }

  // ------------------------------------------------------- rendered QB REF
  console.log("\n4. QB REF cell renders the same by both routes");
  let qbDiffs = 0;
  for (const [id, searchRow] of compared) {
    const filterRow = byIdFilter.get(id)!;
    const viaFilter = qbRefCell(filterRow);
    const viaSearch = qbRefCell(searchRow);
    if (viaFilter !== viaSearch) {
      qbDiffs++;
      if (qbDiffs <= 5) {
        const doc = (filterRow.metadata as any)?.document_number ?? id;
        fail(`${doc}: QB REF "${viaFilter}" via filter vs "${viaSearch}" via search`);
      }
    }
  }
  if (qbDiffs === 0) {
    console.log(`  ✓ identical on all ${compared.size} orders`);
  } else if (qbDiffs > 5) {
    fail(`… and ${qbDiffs - 5} more QB REF divergences`);
  }

  // --------------------------------------------------------------- nominal
  console.log("\n5. Nominal orders");
  for (const doc of NOMINAL_DOCS) {
    const filterRow = [...byIdFilter.values()].find(
      (o) => (o.metadata as any)?.document_number === doc
    );
    if (!filterRow) {
      fail(`${doc}: not present in the filter population — cannot assert on it`);
      continue;
    }
    const searchRow = compared.get(filterRow.id);
    if (!searchRow) {
      fail(`${doc}: no search term returned it — the assert would be vacuous`);
      continue;
    }
    const viaFilter = qbRefCell(filterRow);
    const viaSearch = qbRefCell(searchRow);
    const ok =
      viaFilter === viaSearch &&
      searchRow.fulfillment_status === filterRow.fulfillment_status &&
      !!searchRow.fulfillment_status;
    if (!ok) {
      fail(
        `${doc}: QB REF filter="${viaFilter}" search="${viaSearch}"; ` +
          `fulfillment filter=${JSON.stringify(filterRow.fulfillment_status)} ` +
          `search=${JSON.stringify(searchRow.fulfillment_status)}`
      );
    } else {
      console.log(
        `  ✓ ${doc}: QB REF "${viaFilter}" and fulfillment_status ` +
          `"${searchRow.fulfillment_status}" by both routes ` +
          `(qb_sync_status ${JSON.stringify((filterRow.metadata as any)?.qb_sync_status)})`
      );
    }
  }

  // ------------------------------------------------------------- non-empty
  console.log("\n6. search actually carries the two computed fields");
  const blankFulfillment = [...compared.values()].filter(
    (o) => !o.fulfillment_status
  );
  if (blankFulfillment.length) {
    fail(
      `${blankFulfillment.length}/${compared.size} search rows have an empty ` +
        `fulfillment_status — the original symptom`
    );
  } else {
    console.log(`  ✓ all ${compared.size} search rows carry a fulfillment_status`);
  }
  // Asserted, not merely reported. While this printed a tick next to whatever
  // number it found, the mutation run happily logged "✓ present on 0/442" —
  // a line that agrees with the code no matter what the code does is not a
  // check, and this one sat directly under the symptom it was meant to watch.
  const withPaymentKey = [...compared.values()].filter(
    (o) => o.payment_status !== undefined
  ).length;
  if (withPaymentKey !== compared.size) {
    fail(
      `payment_status missing entirely from ${compared.size - withPaymentKey}/${compared.size} ` +
        `search rows — the key must be present (its value is "" by design, since ` +
        `Medusa computes payment_status and neither route can know it)`
    );
  } else {
    console.log(
      `  ✓ payment_status present on all ${compared.size} search rows ` +
        `(value "" by design — Medusa computes it, so neither route can know it)`
    );
  }

  console.log("\n" + "=".repeat(64));
  if (failures.length) {
    console.error(`FAIL — ${failures.length} problem(s)`);
    process.exit(1);
  }
  console.log("PASS — /admin/orders/search and /admin/orders/filter agree");
}

main().catch((err) => {
  console.error("\nFAIL —", err instanceof Error ? err.message : err);
  process.exit(1);
});
