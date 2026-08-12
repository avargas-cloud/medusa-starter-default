import { readFileSync } from "fs";
import { join } from "path";

import {
  isDraftOrder,
  isIndexableOrder,
  buildOrderDoc,
  type OrderForMeili,
} from "../../lib/meilisearch/build-order-doc";

/**
 * The `orders` index means CONFIRMED ORDERS.
 *
 * Its three readers — orders/filter, orders/counts, orders/search — all hard-filter
 * `is_draft = false`, and the Estimates page never touches MeiliSearch at all: it
 * queries Postgres directly, exactly and without a row cap. So the 258 estimate
 * documents in the index were written, reconciled every 5 minutes and audited
 * nightly for no reader whatsoever.
 *
 * The half of this that is not mere tidiness: `POST /admin/orders/:id/revert-to-draft`
 * turns a confirmed order back into an estimate. Skipping such an order leaves its
 * old document behind — still is_draft=false, still in the Open tab, describing an
 * order that no longer exists as one. Every writer must DELETE, not skip.
 */

function order(overrides: Record<string, unknown> = {}): OrderForMeili {
  return {
    id: "order_1",
    display_id: 7,
    status: "pending",
    is_draft_order: false,
    created_at: "2026-08-01T00:00:00.000Z",
    metadata: {},
    payment_collections: [],
    fulfillments: [],
    items: [],
    ...overrides,
  } as OrderForMeili;
}

describe("isDraftOrder / isIndexableOrder", () => {
  it("a confirmed order is indexable", () => {
    expect(isIndexableOrder(order())).toBe(true);
    expect(isDraftOrder(order())).toBe(false);
  });

  it("the is_draft_order flag alone makes it an estimate", () => {
    // The canonical signal. A cancelled estimate keeps is_draft_order=true while
    // its status drifts to "canceled", which is why status is not enough.
    expect(isIndexableOrder(order({ is_draft_order: true, status: "canceled" }))).toBe(
      false
    );
  });

  it('status "draft" alone makes it an estimate', () => {
    expect(isIndexableOrder(order({ is_draft_order: false, status: "draft" }))).toBe(
      false
    );
  });

  it("agrees with the is_draft the document itself carries", () => {
    // One definition, or the index and the filter that reads it disagree about
    // what a draft is.
    for (const o of [
      order(),
      order({ is_draft_order: true }),
      order({ status: "draft" }),
    ]) {
      expect(buildOrderDoc(o).is_draft).toBe(isDraftOrder(o));
    }
  });
});

describe("every writer removes a document that stopped being indexable", () => {
  const runner = readFileSync(
    join(process.cwd(), "src/lib/meilisearch/sync-orders-runner.ts"),
    "utf8"
  );
  const subscriber = readFileSync(
    join(process.cwd(), "src/subscribers/order-meilisearch-sync.ts"),
    "utf8"
  );

  it("the reindex runner filters non-indexable orders out", () => {
    expect(runner).toContain("isIndexableOrder");
    expect(runner).toMatch(/\.filter\(\s*\(?o\)?\s*=>\s*isIndexableOrder\(o\)\s*\)/);
  });

  it("the subscriber DELETES them instead of merely skipping", () => {
    expect(subscriber).toContain("isIndexableOrder");
    // A skip would leave a reverted-to-draft order sitting in the Open tab.
    expect(subscriber).toContain("deleteDocuments(toDrop)");
  });

  it("the audit repairs what it finds instead of only reporting it", () => {
    const digest = readFileSync(
      join(process.cwd(), "src/jobs/qb-pipeline-error-digest.ts"),
      "utf8"
    );
    expect(digest).toContain("auditOrdersIndex(container, { heal: true })");

    // And the read-only verifier must stay read-only: a verifier that quietly
    // fixes what it finds can no longer tell you whether anything was broken.
    const verifier = readFileSync(
      join(process.cwd(), "src/scripts/verify/verify-meili-orders-integrity.ts"),
      "utf8"
    );
    expect(verifier).not.toContain("heal");
  });

  it("audit and reconciler share the audited fields WITHOUT importing each other", () => {
    // order-reconciler spreads ORDER_AUDITED_FIELDS into its object literal at
    // module-eval time, so a cycle hands whichever file loads second a
    // half-initialised namespace: `[...undefined]`, the sweep dead on boot, with
    // a green type-check. The first attempt at this broke the cycle with a
    // dynamic `await import(...)` — which the unit gate happily asserted as a
    // STRING and which then failed at runtime with ERR_MODULE_NOT_FOUND, because
    // an extensionless dynamic specifier does not resolve under the ESM loader.
    // Hence a leaf module, which has no failure mode to assert around.
    const audit = readFileSync(
      join(process.cwd(), "src/lib/meilisearch/audit-orders-index.ts"),
      "utf8"
    );
    const reconciler = readFileSync(
      join(process.cwd(), "src/lib/meilisearch/reconcilers/order-reconciler.ts"),
      "utf8"
    );
    expect(reconciler).toContain('from "../orders-audited-fields"');
    expect(reconciler).not.toContain("audit-orders-index");
    expect(audit).toContain('from "./orders-audited-fields"');
    // And no dynamic import papering over a cycle that no longer exists.
    expect(audit).not.toContain('await import("./reconcilers');
  });
});
