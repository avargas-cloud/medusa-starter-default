/**
 * What actually happens to a customer's MeiliSearch document when the customer is
 * soft-deleted? Read-mostly probe, SANDBOX ONLY.
 *
 * Three customers were found on 2026-07-29 with `deleted_at` set and their
 * documents still in the `customers` index, so they were still searchable. The
 * suspected chain is: trigger enqueues → the queue processor calls
 * syncCustomerToMeili → retrieveCustomer fails for a deleted customer → the catch
 * logs and swallows → the queue marks it done → the document stays. That is a
 * hypothesis, and the shape of the fix depends on which step actually does what,
 * so this measures instead of assuming.
 *
 * Specifically it answers:
 *   1. Does retrieveCustomer THROW for a soft-deleted customer, or return the row?
 *   2. If it throws, is the error distinguishable as "not found" from a transient
 *      read failure? (Deleting a document on a transient error would remove a LIVE
 *      customer from search, which is worse than leaving a stale one.)
 *   3. Does the trigger enqueue on a soft delete?
 *   4. Does the document survive?
 *
 * Refuses outside the sandbox. It soft-deletes a customer, so it must never point
 * at production.
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import postgres from "postgres";

import { syncCustomerToMeili } from "../../lib/meilisearch/sync-customer";

const SANDBOX_DB_PORT = ":5499";
const SANDBOX_MEILI_PORT = ":7799";

export default async function run({ container }: ExecArgs): Promise<void> {
  const db = process.env.DATABASE_URL ?? "";
  const meili = process.env.MEILISEARCH_HOST ?? "";
  if (!db.includes(SANDBOX_DB_PORT) || !meili.includes(SANDBOX_MEILI_PORT)) {
    console.error(
      `\nREFUSING TO RUN — not the sandbox. This soft-deletes a customer.\n` +
        `  DATABASE_URL needs ${SANDBOX_DB_PORT}, MEILISEARCH_HOST needs ${SANDBOX_MEILI_PORT}.\n`
    );
    process.exit(2);
  }

  const sql = postgres(db, { max: 2 });
  const { MeiliSearch } = await import("meilisearch");
  const index = new MeiliSearch({
    host: meili,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  }).index("customers");

  const docExists = async (id: string): Promise<boolean> => {
    try {
      await index.getDocument(id, { fields: ["id"] });
      return true;
    } catch {
      return false;
    }
  };

  // Declared out here so the restore in `finally` can always reach it. The first
  // version of this probe restored sequentially at the end and crashed on a wrong
  // column name BEFORE getting there, leaving a customer soft-deleted. An undo
  // that only runs on the happy path is not an undo.
  let victimId: string | null = null;

  try {
    // A live customer that already has a document, so the "before" state is known.
    const [victim] = await sql<Array<{ id: string; email: string | null }>>`
      SELECT id, email FROM customer WHERE deleted_at IS NULL ORDER BY updated_at LIMIT 1
    `;
    if (!victim) throw new Error("no live customer to probe with");
    victimId = victim.id;

    console.log(`\nProbing with ${victim.id} (${victim.email ?? "no email"})\n`);
    console.log(`  document before        : ${(await docExists(victim.id)) ? "present" : "ABSENT"}`);

    const customerModule = container.resolve(Modules.CUSTOMER) as {
      retrieveCustomer: (id: string, cfg?: unknown) => Promise<unknown>;
    };

    // ── Question 1+2: how does retrieve behave once the row is soft-deleted?
    await sql`UPDATE customer SET deleted_at = now() WHERE id = ${victim.id}`;
    console.log(`  soft-deleted in the database`);

    let retrieveOutcome = "";
    let errShape = "";
    try {
      const c = await customerModule.retrieveCustomer(victim.id, { relations: ["groups"] });
      retrieveOutcome = c ? "RETURNED THE ROW (does not respect deleted_at)" : "returned null/undefined";
    } catch (err: unknown) {
      const e = err as { name?: string; type?: string; message?: string; code?: string };
      retrieveOutcome = "THREW";
      errShape =
        `name=${e.name} type=${e.type ?? "(none)"} code=${e.code ?? "(none)"} ` +
        `message="${(e.message ?? "").slice(0, 90)}"`;
    }
    console.log(`  retrieveCustomer       : ${retrieveOutcome}`);
    if (errShape) console.log(`    error shape          : ${errShape}`);

    // ── Question 3: did the trigger enqueue? (the column is queued_at, not created_at)
    const queued = await sql<Array<{ n: number; op: string | null }>>`
      SELECT count(*)::int AS n, max(op) AS op FROM meili_sync_queue
      WHERE entity_type = 'customer' AND entity_id = ${victim.id}
        AND queued_at > now() - interval '2 minutes'
    `;
    console.log(
      `  rows enqueued by trigger: ${queued[0]?.n ?? 0}${queued[0]?.op ? ` (op=${queued[0].op})` : ""}`
    );

    // ── Question 4: is the document still there before anything syncs?
    console.log(
      `  document after delete  : ${(await docExists(victim.id)) ? "still present" : "gone"}`
    );

    // ── The fix, end to end: this is the function the queue processor calls.
    console.log(`  calling syncCustomerToMeili…`);
    await syncCustomerToMeili(victim.id, container);
    await new Promise((r) => setTimeout(r, 2500));
    const gone = !(await docExists(victim.id));
    console.log(
      `  document after sync    : ${gone ? "GONE — the fix removed it ✅" : "STILL PRESENT — the fix did not fire ❌"}`
    );
  } finally {
    if (victimId) {
      await sql`UPDATE customer SET deleted_at = NULL WHERE id = ${victimId}`;
      const [check] = await sql<Array<{ deleted_at: Date | null }>>`
        SELECT deleted_at FROM customer WHERE id = ${victimId}
      `;
      // Undo BOTH halves: un-deleting the row is not enough, because by now the
      // fix has removed its document. Leaving it un-synced would hand the next
      // person a missing document that looks like the very bug being fixed.
      await syncCustomerToMeili(victimId, container).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      const back = await docExists(victimId);
      console.log(
        `\n  restored               : row ${check?.deleted_at === null ? "un-deleted" : "STILL DELETED — FIX BY HAND"}` +
          ` · document ${back ? "re-synced" : "MISSING — FIX BY HAND"}\n`
      );
    }
    await sql.end();
  }
}
