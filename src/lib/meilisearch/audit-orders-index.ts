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

import { isDocumentNotFound, isIndexNotFound } from "./meili-errors";
import {
  ORDER_AUDITED_FIELDS,
  type OrderAuditedField,
} from "./orders-audited-fields";
import { orderReconciler } from "./reconcilers/order-reconciler";
import { sameIndexedValue } from "./same-indexed-value";
import { ORDERS_INDEX, buildAllOrderDocs } from "./sync-orders-runner";


type Doc = Record<string, unknown>;

/** One field of one order that the index gets wrong. */
// Re-exported: the constant moved to its own leaf module to break the import
// cycle with order-reconciler. Existing importers keep working.
export { ORDER_AUDITED_FIELDS, type OrderAuditedField };

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
  /**
   * Present only when the caller asked to heal. Absent means "nobody tried",
   * which must never read the same as "tried and there was nothing to do".
   */
  heal?: OrderIndexHealResult;
}

export interface OrderIndexHealResult {
  /** Ids re-synced AND confirmed correct by re-reading the index afterwards. */
  repaired: string[];
  /** Ids the repair ran on but that still disagree, or that threw. */
  unrepaired: Array<{ order_id: string; reason: string }>;
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
    let page: Awaited<ReturnType<typeof index.getDocuments<Doc>>>;
    try {
      page = await index.getDocuments<Doc>({
        limit: PAGE,
        offset,
        fields: ["id", ...ORDER_AUDITED_FIELDS] as string[],
      });
    } catch (err: unknown) {
      // A fresh sandbox has the tables but not the indexes, and Meili's own error
      // for that reads like a bug in this code. Say what to run instead.
      if (isIndexNotFound(err)) {
        throw new Error(
          `the "${ORDERS_INDEX}" index does not exist on ${process.env.MEILISEARCH_HOST} — ` +
            `build it first with: medusa exec ./src/scripts/sync/sync-meili-orders.ts`
        );
      }
      throw err;
    }
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
  container: MedusaContainer,
  opts?: {
    /**
     * Repair what the audit finds, then verify the repair. Off by default so the
     * verifier script stays read-only. See healOrders.
     */
    heal?: boolean;
  }
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

  const result: OrderIndexAuditResult = {
    ordersInDb: expectedDocs.length,
    docsInIndex: indexed.size,
    missing,
    orphans,
    driftedDocs,
    drifts,
    clean: driftedDocs === 0 && missing.length === 0 && orphans.length === 0,
  };

  if (opts?.heal) {
    const ids = [
      ...new Set([
        ...drifts.map((d) => d.order_id),
        ...missing.map((m) => m.order_id),
        ...orphans,
      ]),
    ];
    result.heal = await healOrders(ids, container);
  }

  return result;
}

/**
 * Re-syncs the named orders and CONFIRMS the repair by reading the index back.
 *
 * Why this exists at all: the 5-minute reconciliation sweep only looks at rows
 * touched in the last 6 minutes. A document that goes wrong and then goes quiet
 * is never revisited by anything — and that is not hypothetical. S11417 was
 * detected and repaired by the sweep on 2026-08-11 at 14:50, broke again, and
 * then sat wrong for a full day while this audit named it in the digest every
 * night and repaired nothing. An audit that can see the damage and not touch it
 * turns a self-healing system into a mailing list.
 *
 * Three things it deliberately does NOT do:
 *
 *   • It does not implement its own repair. `orderReconciler.syncOne` is the one
 *     the sweep uses, drift_log stamping included; a second repair path would rot
 *     away from that one, which is the failure mode this whole net exists for.
 *   • It does not trust itself. syncOne resolving without throwing is not proof
 *     the document is right — the index write is asynchronous and the rebuild
 *     could reproduce the same wrong value. Every id is re-read and re-diffed,
 *     and only then counted as repaired.
 *   • It does not run unless asked. `verify-meili-orders-integrity.ts` stays
 *     read-only: a verifier that silently fixes what it finds can no longer tell
 *     you whether anything was broken.
 *
 * An orphan is repaired too, and by the same call: syncOne deletes the document
 * when the order is gone or is no longer indexable (an estimate, or an order
 * reverted to draft).
 */
async function healOrders(
  ids: string[],
  container: MedusaContainer
): Promise<OrderIndexHealResult> {
  const repaired: string[] = [];
  const unrepaired: OrderIndexHealResult["unrepaired"] = [];
  if (ids.length === 0) return { repaired, unrepaired };

  const silent = { info: () => {}, warn: () => {}, error: () => {} };


  const { MeiliSearch } = await import("meilisearch");
  const index = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  }).index(ORDERS_INDEX);

  for (const id of ids) {
    try {
      await orderReconciler.syncOne(id, container);

      // Re-read and re-diff. Meili applies document writes asynchronously, so
      // poll briefly rather than declaring victory on the first read.
      const [expected] = (await buildAllOrderDocs(container, silent, [id])) as
        unknown as Doc[];

      let confirmed = false;
      let lastReason = "";
      for (let attempt = 0; attempt < 12 && !confirmed; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 250));

        let actual: Doc | null = null;
        try {
          actual = (await index.getDocument(id)) as Doc;
        } catch (err: unknown) {
          if (!isDocumentNotFound(err)) throw err;
          actual = null;
        }

        if (!expected) {
          // Not indexable (estimate / reverted to draft) or gone: absence IS
          // the correct end state.
          confirmed = actual === null;
          lastReason = confirmed ? "" : "document should have been deleted and is still present";
          continue;
        }
        if (!actual) {
          lastReason = "document still missing from the index";
          continue;
        }
        const stillOff = ORDER_AUDITED_FIELDS.filter(
          (f) => !sameIndexedValue(expected[f], actual![f])
        );
        confirmed = stillOff.length === 0;
        lastReason = confirmed ? "" : `still drifted on: ${stillOff.join(", ")}`;
      }

      if (confirmed) repaired.push(id);
      else unrepaired.push({ order_id: id, reason: lastReason });
    } catch (err: unknown) {
      unrepaired.push({ order_id: id, reason: (err as Error).message });
    }
  }

  return { repaired, unrepaired };
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
