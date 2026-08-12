import type { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";

import {
  buildOrderDoc,
  type OrderForMeili,
} from "../../lib/meilisearch/build-order-doc";
import { syncOrders } from "../../subscribers/order-meilisearch-sync";

/**
 * E2E, sandbox only. Drives the EXACT path the event subscriber uses —
 * query.graph → SQL enrichment → buildOrderDoc → MeiliSearch — against a real
 * Postgres and a real Meili, and asserts the tab membership that comes out.
 *
 * The unit specs prove the enrichment is correct in isolation. They cannot prove
 * the subscriber's own field set and wiring produce the right document, and that
 * is precisely what was wrong: the subscriber asked query.graph for less than the
 * reindex runner did, so a partially-delivered order indexed as `delivered`,
 * flipped is_open to false, and left the Open Orders tab (S11417, 2026-08-11).
 *
 * Controls, both mandatory — an assertion that "nothing is wrong" proves nothing
 * unless the harness can tell right from wrong:
 *   POSITIVE  a fully-delivered order must still index as delivered/closed,
 *             so the fix cannot be "call everything partial".
 *   NEGATIVE  the same order built WITHOUT line quantities must produce
 *             `delivered`, reproducing the bug on demand. If this stops
 *             reproducing, this test has stopped measuring anything.
 *
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *       MEILISEARCH_HOST='http://localhost:7799' \
 *       MEILISEARCH_API_KEY='sandbox_master_key' \
 *       DISABLE_SCHEDULED_JOBS=true \
 *     npx medusa exec ./src/scripts/tests/e2e-order-fulfillment-index-sandbox.ts
 */

const PARTIAL_SQL = `
  WITH cur AS (
    SELECT o.id,
           o.metadata->>'document_number' AS doc,
           SUM(oi.quantity)           AS qty,
           SUM(oi.fulfilled_quantity) AS ful
      FROM "order" o
      JOIN order_item oi
        ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
     WHERE o.deleted_at IS NULL AND o.status = 'pending'
     GROUP BY o.id, o.metadata->>'document_number'
  ), f AS (
    SELECT ofu.order_id,
           COUNT(*)                                             AS n_active,
           COUNT(*) FILTER (WHERE fl.delivered_at IS NOT NULL)   AS n_delivered
      FROM order_fulfillment ofu
      JOIN fulfillment fl ON fl.id = ofu.fulfillment_id
     WHERE ofu.deleted_at IS NULL AND fl.deleted_at IS NULL AND fl.canceled_at IS NULL
     GROUP BY ofu.order_id
  )
  SELECT cur.id, cur.doc, cur.qty, cur.ful
    FROM cur JOIN f ON f.order_id = cur.id
   WHERE cur.ful < cur.qty
     AND f.n_delivered = f.n_active
   ORDER BY cur.id DESC
   LIMIT 1`;

const FULL_SQL = `
  WITH cur AS (
    SELECT o.id,
           o.metadata->>'document_number' AS doc,
           SUM(oi.quantity)           AS qty,
           SUM(oi.fulfilled_quantity) AS ful
      FROM "order" o
      JOIN order_item oi
        ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
     WHERE o.deleted_at IS NULL
     GROUP BY o.id, o.metadata->>'document_number'
  ), f AS (
    SELECT ofu.order_id,
           COUNT(*)                                           AS n_active,
           COUNT(*) FILTER (WHERE fl.delivered_at IS NOT NULL) AS n_delivered
      FROM order_fulfillment ofu
      JOIN fulfillment fl ON fl.id = ofu.fulfillment_id
     WHERE ofu.deleted_at IS NULL AND fl.deleted_at IS NULL AND fl.canceled_at IS NULL
     GROUP BY ofu.order_id
  )
  SELECT cur.id, cur.doc, cur.qty, cur.ful
    FROM cur JOIN f ON f.order_id = cur.id
   WHERE cur.ful >= cur.qty
     AND f.n_delivered = f.n_active
   ORDER BY cur.id DESC
   LIMIT 1`;

type Row = { id: string; doc: string | null; qty: string; ful: string };

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${
      ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`
    }`
  );
}

export default async function e2eOrderFulfillmentIndex({
  container,
}: {
  container: MedusaContainer;
}) {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const meiliHost = process.env.MEILISEARCH_HOST ?? "";
  if (!dbUrl.includes("5499") || !meiliHost.includes("7799")) {
    throw new Error(
      `REFUSING TO RUN: this test writes MeiliSearch documents and must only ` +
        `touch the sandbox stack (pg 5499 / meili 7799). Got DATABASE_URL=${
          dbUrl.replace(/:[^:@/]*@/, ":***@")
        } MEILISEARCH_HOST=${meiliHost}`
    );
  }

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const partial = (await db.query<Row>(PARTIAL_SQL)).rows[0];
  const full = (await db.query<Row>(FULL_SQL)).rows[0];
  await db.end();

  if (!partial) {
    throw new Error(
      "No partially-fulfilled order in the sandbox snapshot — the case under " +
        "test does not exist here, so a green run would mean nothing."
    );
  }

  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: (m: string) => console.log(`    [sync error] ${m}`),
  };

  const { MeiliSearch } = await import("meilisearch");
  const index = new MeiliSearch({
    host: meiliHost,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  }).index("orders");

  async function docFor(id: string): Promise<Record<string, unknown>> {
    // updateDocuments is async on Meili's side; poll briefly for the write.
    for (let i = 0; i < 20; i++) {
      try {
        const d = (await index.getDocument(id)) as Record<string, unknown>;
        if (d) return d;
      } catch {
        /* not there yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`document ${id} never appeared in the sandbox index`);
  }

  console.log(
    `\nSubject   : ${partial.doc ?? partial.id} — ${partial.ful} of ${partial.qty} fulfilled, all fulfillments delivered`
  );

  console.log("\n1. The subscriber's own path keeps a part-delivered order OPEN");
  await syncOrders([partial.id], container, silentLogger);
  const partialDoc = await docFor(partial.id);
  check("fulfillment_status", partialDoc.fulfillment_status, "partially_delivered");
  check("is_open", partialDoc.is_open, true);
  check("is_closed", partialDoc.is_closed, false);

  console.log("\n2. POSITIVE CONTROL — a fully-delivered order still closes");
  if (!full) {
    console.log("  SKIP  no fully-delivered order in this snapshot");
  } else {
    console.log(`  subject: ${full.doc ?? full.id} — ${full.ful} of ${full.qty}`);
    await syncOrders([full.id], container, silentLogger);
    const fullDoc = await docFor(full.id);
    check("fulfillment_status", fullDoc.fulfillment_status, "delivered");
    check("is_closed", fullDoc.is_closed, true);
  }

  console.log("\n3. NEGATIVE CONTROL — drop the line quantities and the bug returns");
  // Built from scratch, NOT spread from the indexed document: that doc already
  // carries a fulfillment_status, and buildOrderDoc prefers a non-empty native
  // value over its own computation — so spreading it would assert the field it
  // was handed and measure nothing. (Cost one red run to learn.)
  const stripped = {
    id: partial.id,
    display_id: 0,
    status: "pending",
    is_draft_order: false,
    created_at: new Date().toISOString(),
    metadata: {},
    payment_collections: [],
    fulfillments: [{ delivered_at: new Date() }],
    items: undefined,
  } as unknown as OrderForMeili;
  const strippedDoc = buildOrderDoc(stripped);
  check("fulfillment_status without items", strippedDoc.fulfillment_status, "delivered");
  check("is_open without items", strippedDoc.is_open, false);

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`
  );
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
}
