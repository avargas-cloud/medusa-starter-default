import type { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";

import { auditOrdersIndex } from "../../lib/meilisearch/audit-orders-index";
import { ORDERS_INDEX } from "../../lib/meilisearch/sync-orders-runner";

/**
 * E2E, sandbox only. Proves the nightly audit REPAIRS what it finds — and that
 * it can tell a repair from a claim.
 *
 * The gap this closes: the 5-minute reconciliation sweep enumerates rows touched
 * in the last 6 minutes, so a document that goes wrong and then goes quiet is
 * beyond its reach permanently. The audit could already see that damage and did
 * nothing but name it in an email. S11417 spent a full day out of the Open Orders
 * tab that way, reported every night, repaired never.
 *
 * Also covers the scope change: an estimate has no document in this index, so a
 * leftover one must be DELETED. That is not tidiness — revert-to-draft turns a
 * confirmed order back into an estimate, and its stale document would otherwise
 * keep sitting in the Open tab.
 *
 * Controls:
 *   NEGATIVE  with heal off, the same planted damage must survive. Without this,
 *             a test that ends "the index is correct" would also pass against a
 *             heal that never ran.
 *   POSITIVE  the audit must actually SEE the damage (report it) before claiming
 *             to have fixed it — otherwise "0 unrepaired" just means "0 looked at".
 *
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *       MEILISEARCH_HOST='http://localhost:7799' \
 *       MEILISEARCH_API_KEY='sandbox_master_key' \
 *       DISABLE_SCHEDULED_JOBS=true \
 *     npx medusa exec ./src/scripts/tests/e2e-orders-index-heal-sandbox.ts
 */

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

export default async function e2eOrdersIndexHeal({
  container,
}: {
  container: MedusaContainer;
}) {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const meiliHost = process.env.MEILISEARCH_HOST ?? "";
  if (!dbUrl.includes("5499") || !meiliHost.includes("7799")) {
    throw new Error(
      `REFUSING TO RUN: this test plants wrong documents in the orders index and ` +
        `must only touch the sandbox stack (pg 5499 / meili 7799). Got ` +
        `MEILISEARCH_HOST=${meiliHost}`
    );
  }

  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  // The victim must be an order whose CORRECT document says is_open = true —
  // otherwise flipping it to closed plants no damage at all and every assertion
  // below passes vacuously. The first run of this test picked the most recent
  // confirmed order, drew S11441 (4 of 4 delivered, correctly closed), and
  // "reported the drift" failed for the only honest reason: there was none.
  const victim = (
    await db.query<{ id: string; doc: string | null }>(
      `SELECT o.id, o.metadata->>'document_number' AS doc
         FROM "order" o
         JOIN order_item oi
           ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
        WHERE o.deleted_at IS NULL
          AND o.status = 'pending'
          AND NOT (o.is_draft_order = true OR o.status = 'draft')
        GROUP BY o.id, o.metadata->>'document_number'
       HAVING SUM(oi.fulfilled_quantity) < SUM(oi.quantity)
        ORDER BY o.id DESC
        LIMIT 1`
    )
  ).rows[0];
  const draft = (
    await db.query<{ id: string; doc: string | null }>(
      `SELECT id, metadata->>'document_number' AS doc
         FROM "order"
        WHERE deleted_at IS NULL
          AND (is_draft_order = true OR status = 'draft')
        ORDER BY created_at DESC
        LIMIT 1`
    )
  ).rows[0];
  await db.end();

  if (!victim || !draft) {
    throw new Error(
      "sandbox snapshot lacks a confirmed order and/or an estimate — a green run would mean nothing"
    );
  }

  const { MeiliSearch } = await import("meilisearch");
  const index = new MeiliSearch({
    host: meiliHost,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  }).index(ORDERS_INDEX);

  async function settle(): Promise<void> {
    // Meili applies writes asynchronously; give the queue a moment to drain.
    await new Promise((r) => setTimeout(r, 1500));
  }
  async function docOrNull(id: string): Promise<Record<string, unknown> | null> {
    try {
      return (await index.getDocument(id)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async function plantDamage(): Promise<void> {
    // A value the database contradicts: a real order marked closed and not open.
    await index.updateDocuments(
      [{ id: victim.id, is_open: false, is_closed: true, fulfillment_status: "delivered" }],
      { primaryKey: "id" }
    );
    // An estimate document, which the index must no longer hold at all.
    await index.updateDocuments(
      [{ id: draft.id, display_id: 999999, is_draft: true, is_open: false, is_closed: false }],
      { primaryKey: "id" }
    );
    await settle();
  }

  console.log(
    `\nVictim    : ${victim.doc ?? victim.id} (confirmed order)\nEstimate  : ${draft.doc ?? draft.id}`
  );

  console.log("\n1. NEGATIVE CONTROL — heal OFF leaves the damage exactly where it is");
  await plantDamage();
  const dry = await auditOrdersIndex(container);
  const sawVictim = dry.drifts.some((d) => d.order_id === victim.id);
  const sawDraft = dry.orphans.includes(draft.id);
  check("audit reports the drifted order", sawVictim, true);
  check("audit reports the estimate doc as orphaned", sawDraft, true);
  check("no heal result when not asked", dry.heal, undefined);
  const stillWrong = await docOrNull(victim.id);
  check("damage survives an audit that does not heal", stillWrong?.is_open, false);
  check("estimate doc survives too", (await docOrNull(draft.id)) !== null, true);

  console.log("\n2. heal ON repairs both, and confirms each by re-reading");
  const healed = await auditOrdersIndex(container, { heal: true });
  check("heal result present", healed.heal !== undefined, true);
  check(
    "the drifted order is repaired",
    healed.heal?.repaired.includes(victim.id),
    true
  );
  check(
    "the estimate document is repaired (deleted)",
    healed.heal?.repaired.includes(draft.id),
    true
  );
  check("nothing left unrepaired", healed.heal?.unrepaired ?? [], []);

  console.log("\n3. The index actually agrees now");
  await settle();
  const fixed = await docOrNull(victim.id);
  check("order back to open", fixed?.is_open, true);
  check("order no longer closed", fixed?.is_closed, false);
  check("estimate document is gone", await docOrNull(draft.id), null);

  console.log("\n4. A second audit finds nothing to do");
  const after = await auditOrdersIndex(container, { heal: true });
  check("no drift on the victim", after.drifts.some((d) => d.order_id === victim.id), false);
  check("estimate not reported again", after.orphans.includes(draft.id), false);

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`
  );
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
}
