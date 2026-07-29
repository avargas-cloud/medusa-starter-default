/**
 * Compares the `orders` MeiliSearch index against the database, field by field.
 *
 * Orders were the ONE important entity whose index sync depended entirely on
 * some route remembering to emit an event. Everything else — products, variants,
 * customers, inventory levels, reservations, vendors, POs, FOs — had a Postgres
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
 * This module holds the comparison ONCE. Two callers share it:
 *   - src/scripts/verify/verify-meili-orders-integrity.ts (prints + exit code)
 *   - src/jobs/qb-pipeline-error-digest.ts (daily email section)
 * A second comparator would drift away from the first, which is literally the
 * class of bug this whole safety net exists to prevent.
 *
 * KNOWN AND DELIBERATE LIMITATION — do not "fix" this without deciding it first:
 * the expected doc is built through the same path the sync uses. That is on
 * purpose (a different fetch would invent drift), and the cost is that it cannot
 * tell that path is itself stale. Observed 2026-07-29: a run reported 0 drift and
 * 40 minutes later found order #2654 (`voided` in the database, `fully_paid` in
 * the index) because query.graph had returned old metadata and sync and audit
 * agreed on the same wrong value. This detects index-vs-database, not
 * database-vs-reality. Covering that is a different design.
 *
 * Read-only. Writes nothing to Postgres or MeiliSearch.
 */
import type { MedusaContainer } from "@medusajs/framework/types";

import { ORDERS_INDEX, buildAllOrderDocs } from "./sync-orders-runner";

/**
 * Fields whose drift changes what the operator sees or which tab an order is in.
 *
 * Single source of truth: the reconciler's `comparableFields` reads this same
 * constant. Two lists is how the audit and the 5-minute sweep would start
 * disagreeing about what "drifted" means.
 *
 * `updated_at_ts` is deliberately absent: it moves on every touch and would
 * report drift on rows that are otherwise identical.
 */
export const ORDER_AUDITED_FIELDS = [
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
  "customer_name",
  "company_name",
  "customer_email",
] as const;

export type OrderAuditedField = (typeof ORDER_AUDITED_FIELDS)[number];

type Doc = Record<string, unknown>;

/** One field of one order that the index gets wrong. */
export interface OrderFieldDrift {
  order_id: string;
  display_id: number | null;
  field: string;
  /** What the database says the value should be. */
  expected: unknown;
  /** What the index currently holds. */
  actual: unknown;
}

export interface OrderIndexAuditResult {
  ordersInDb: number;
  docsInIndex: number;
  /** Orders the database has and the index does not. */
  missing: Array<{ order_id: string; display_id: number | null }>;
  /** Document ids the index has and the database does not. */
  orphans: string[];
  /** Documents with at least one wrong field (not the count of wrong fields). */
  driftedDocs: number;
  /** One entry per (order, field). Ordered by display_id, then field. */
  drifts: OrderFieldDrift[];
  clean: boolean;
}

/**
 * Same value, allowing for the sloppiness a value survives a round trip as.
 *
 * Money and timestamps come back from query.graph as string or BigNumber and from
 * Meili as number, and "missing" serializes as "" on one side and null on the
 * other. Neither is drift, and reporting it as such is how a drift report gets
 * ignored.
 */
export function sameIndexedValue(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;

  if (typeof expected === "number" || typeof actual === "number") {
    const a = Number(expected);
    const b = Number(actual);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < 0.01;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return false;
    const sa = [...expected].sort();
    const sb = [...actual].sort();
    return sa.every((v, i) => v === sb[i]);
  }

  const empty = (v: unknown) => v === "" || v === null || v === undefined;
  return empty(expected) && empty(actual);
}

/** Every document currently in the index, keyed by id, audited fields only. */
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
      fields: ["id", ...ORDER_AUDITED_FIELDS] as string[],
    });
    for (const doc of page.results) byId.set(String(doc.id), doc);
    if (page.results.length < PAGE) break;
    offset += PAGE;
  }
  return byId;
}

const toDisplayId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Runs the full audit. ~13s over 1,500 orders — every document is rebuilt, so
 * this belongs in a daily job, never in the 5-minute reconciliation sweep.
 */
export async function auditOrdersIndex(
  container: MedusaContainer
): Promise<OrderIndexAuditResult> {
  // Silent by default: the audit's own progress lines are noise inside a digest
  // job, and the script prints its own report anyway.
  const silent = { info: () => {}, warn: () => {}, error: () => {} };

  const [expectedDocs, indexed] = await Promise.all([
    buildAllOrderDocs(container, silent),
    fetchIndexedDocs(),
  ]);

  const missing: OrderIndexAuditResult["missing"] = [];
  const drifts: OrderFieldDrift[] = [];
  let driftedDocs = 0;

  for (const expected of expectedDocs as unknown as Doc[]) {
    const orderId = String(expected.id);
    const displayId = toDisplayId(expected.display_id);
    const actual = indexed.get(orderId);

    if (!actual) {
      missing.push({ order_id: orderId, display_id: displayId });
      continue;
    }

    let rowDrifted = false;
    for (const field of ORDER_AUDITED_FIELDS) {
      if (sameIndexedValue(expected[field], actual[field])) continue;
      rowDrifted = true;
      drifts.push({
        order_id: orderId,
        display_id: displayId,
        field,
        expected: expected[field],
        actual: actual[field],
      });
    }
    if (rowDrifted) driftedDocs += 1;
  }

  const expectedIds = new Set(
    (expectedDocs as unknown as Doc[]).map((d) => String(d.id))
  );
  const orphans = [...indexed.keys()].filter((id) => !expectedIds.has(id));

  drifts.sort(
    (a, b) =>
      (a.display_id ?? 0) - (b.display_id ?? 0) || a.field.localeCompare(b.field)
  );

  return {
    ordersInDb: expectedDocs.length,
    docsInIndex: indexed.size,
    missing,
    orphans,
    driftedDocs,
    drifts,
    clean: driftedDocs === 0 && missing.length === 0 && orphans.length === 0,
  };
}

/** Worst-offending field first — the shape both the script and the email want. */
export function groupDriftsByField(
  drifts: readonly OrderFieldDrift[]
): Array<{ field: string; rows: OrderFieldDrift[] }> {
  const byField = new Map<string, OrderFieldDrift[]>();
  for (const d of drifts) {
    const list = byField.get(d.field) ?? [];
    list.push(d);
    byField.set(d.field, list);
  }
  return [...byField]
    .map(([field, rows]) => ({ field, rows }))
    .sort((a, b) => b.rows.length - a.rows.length || a.field.localeCompare(b.field));
}
