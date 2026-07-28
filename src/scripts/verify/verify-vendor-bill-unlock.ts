/**
 * verify-vendor-bill-unlock.ts
 *
 * Verifies `claimUnlock` (`lib/purchase-orders/qb-vendor-bill-unlock.ts`) —
 * the guard/claim logic shared by `POST /admin/vendor-bills/:id/qb-unlock`.
 *
 * Cases:
 *   1. Bill not synced (`qb_txn_id IS NULL`) → `bill_not_synced`.
 *   2. Synced bill with a `synced` pipeline row → claim succeeds, freezes
 *      preflight + delete in one PO dependency chain, and audits the request.
 *   3. Same bill claimed again while still `rebuild_prepare` →
 *      `unlock_already_in_flight`.
 *
 * SANDBOX ONLY. Connects to the sandbox DB by default. Everything happens
 * inside one transaction that is always ROLLBACK'd, never COMMIT'd — no
 * synthetic row ever persists. Mirrors `verify-vendor-bill-poller-gates.ts`.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-vendor-bill-unlock.ts
 */

import { Client } from "pg";
import { claimUnlock, type UnlockKnex } from "../../lib/purchase-orders/qb-vendor-bill-unlock";

const SANDBOX_DEFAULT_URL = "postgresql://postgres:sandbox@localhost:5499/medusa";

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Adapts a pg Client to the `?`-placeholder knex.raw shape claimUnlock expects. */
function asKnexRaw(client: Client): UnlockKnex {
  const adapter: UnlockKnex = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      const res = await client.query(pgSql, bindings as never[]);
      return { rows: res.rows, rowCount: res.rowCount ?? undefined };
    },
    transaction: async <T>(handler: (trx: UnlockKnex) => Promise<T>) =>
      handler(adapter),
  };
  return adapter;
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
    [table]
  );
  return (res.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL || SANDBOX_DEFAULT_URL;
  const usingDefault = !process.env.DATABASE_URL;
  console.log(
    `Connecting to ${usingDefault ? "sandbox (default)" : "DATABASE_URL override"}: ` +
      connectionString.replace(/:[^:@/]+@/, ":****@")
  );

  const client = new Client({ connectionString });
  await client.connect();

  try {
    if (
      !(await tableExists(client, "qb_vendor_bill_pipeline")) ||
      !(await tableExists(client, "vendor_bill")) ||
      !(await tableExists(client, "qb_purchase_dependency_chain"))
    ) {
      console.log(
        "\n⏭  SKIP: the Vendor Bill purchase-chain tables do not exist in this " +
          "database yet. Nothing to verify; re-run once the migration is applied.\n"
      );
      process.exit(0);
    }

    const knex = asKnexRaw(client);

    await client.query("BEGIN");
    try {
      const stamp = Date.now();
      const billId = `vb_verify_unlock_${stamp}`;
      const pipelineRowId = `qbvbpipe_verify_unlock_${stamp}`;
      const fakeTxnId = `TXN-VERIFY-${stamp}`;
      const fakePoId = `po_verify_unlock_${stamp}`;
      const previousPayload = { po_id: "po_verify", item_lines: [{ sku: "SKU-1" }] };

      // ── Seed a minimal synthetic vendor_bill (no FK constraints outside
      // purchase_order_receipt_id, left NULL) ────────────────────────────────
      await client.query(
        `INSERT INTO vendor_bill
           (id, status, bill_type, purchase_order_id, qb_txn_id)
         VALUES ($1, 'draft', 'regular', $2, NULL)`,
        [billId, fakePoId]
      );

      // ── Case 1: bill not synced (qb_txn_id IS NULL) → bill_not_synced ──────
      console.log("\n=== 1. Unsynced bill → bill_not_synced ===");
      const notSyncedResult = await claimUnlock(knex, billId, {
        reason: "verify: case 1",
        actorId: "user_verify",
      });
      assert(
        "claimUnlock returns bill_not_synced",
        !notSyncedResult.ok && notSyncedResult.code === "bill_not_synced",
        JSON.stringify(notSyncedResult)
      );

      // ── Sync the bill + seed its pipeline row (synced ADD lifecycle) ──────
      await client.query(
        `UPDATE vendor_bill SET status = 'synced', qb_txn_id = $2 WHERE id = $1`,
        [billId, fakeTxnId]
      );

      // ── Case 2: existing-line edits must never trigger a rebuild ─────────
      console.log("\n=== 2. No new PO line → bill_rebuild_not_required ===");
      const notRequiredResult = await claimUnlock(knex, billId, {
        reason: "verify: case 2",
        actorId: "user_verify",
      });
      assert(
        "claimUnlock rejects rebuild when no new PO-linked line exists",
        !notRequiredResult.ok &&
          notRequiredResult.code === "bill_rebuild_not_required",
        JSON.stringify(notRequiredResult)
      );

      await client.query(
        `INSERT INTO vendor_bill_line
           (id, vendor_bill_id, purchase_order_line_id, line_type,
            sku, description, qty, unit_cost_cents, qb_txn_line_id)
         VALUES ($1, $2, $3, 'product',
                 'VERIFY-NEW-LINE', 'Verifier new PO line', 1, 100, NULL)`,
        [
          `vbl_verify_unlock_${stamp}`,
          billId,
          `pol_verify_unlock_${stamp}`,
        ]
      );
      await client.query(
        `INSERT INTO qb_vendor_bill_pipeline
           (id, vendor_bill_id, purchase_order_id, status, intent, qb_txn_id, payload)
         VALUES ($1, $2, $3, 'synced', 'add', $4, $5::jsonb)`,
        [
          pipelineRowId,
          billId,
          fakePoId,
          fakeTxnId,
          JSON.stringify(previousPayload),
        ]
      );

      // ── Case 3: new PO-linked line → chain + audit frozen ─────────────────
      console.log("\n=== 3. New PO line → preflight/delete chain is frozen ===");
      const claimResult = await claimUnlock(knex, billId, {
        reason: "verify: case 3 — testing rebuild",
        actorId: "user_verify_actor",
      });
      assert(
        "claimUnlock returns ok:true with the existing pipeline row id",
        claimResult.ok === true && claimResult.pipelineRowId === pipelineRowId,
        JSON.stringify(claimResult)
      );

      const rowAfterClaim = (
        await client.query(
          `SELECT intent, status, qb_operation_id, retries, snapshot,
                  order_pipeline_id::text
             FROM qb_vendor_bill_pipeline WHERE id = $1`,
          [pipelineRowId]
        )
      ).rows[0];
      assert(
        "row flipped to intent='rebuild_prepare'",
        rowAfterClaim?.intent === "rebuild_prepare",
        JSON.stringify(rowAfterClaim)
      );
      assert("row flipped to status='waiting'", rowAfterClaim?.status === "waiting");
      assert("qb_operation_id cleared", rowAfterClaim?.qb_operation_id === null);
      assert("retries reset to 0", rowAfterClaim?.retries === 0);
      assert(
        "snapshot carries rebuild_reason",
        rowAfterClaim?.snapshot?.rebuild_reason === "verify: case 3 — testing rebuild",
        JSON.stringify(rowAfterClaim?.snapshot)
      );
      assert(
        "snapshot carries requested_by",
        rowAfterClaim?.snapshot?.requested_by === "user_verify_actor"
      );
      assert(
        "snapshot carries requested_at",
        typeof rowAfterClaim?.snapshot?.requested_at === "string"
      );
      assert(
        "snapshot.previous_payload matches the pre-unlock payload",
        JSON.stringify(rowAfterClaim?.snapshot?.previous_payload) ===
          JSON.stringify(previousPayload),
        JSON.stringify(rowAfterClaim?.snapshot?.previous_payload)
      );

      const chainRows = (
        await client.query(
          `SELECT id::text, step, status, depends_on::text
             FROM qb_order_pipeline
            WHERE order_id = $1
              AND step IN (
                'vendor_bill_rebuild_preflight',
                'vendor_bill_rebuild_delete'
              )
            ORDER BY created_at, id`,
          [fakePoId]
        )
      ).rows;
      const preflight = chainRows.find(
        (row) => row.step === "vendor_bill_rebuild_preflight"
      );
      const deletion = chainRows.find(
        (row) => row.step === "vendor_bill_rebuild_delete"
      );
      assert(
        "preflight is the first runnable operation",
        preflight?.status === "pending" && preflight?.depends_on === null,
        JSON.stringify(chainRows)
      );
      assert(
        "delete waits on the preflight",
        deletion?.status === "waiting" &&
          deletion?.depends_on === preflight?.id,
        JSON.stringify(chainRows)
      );
      assert(
        "legacy row points at the destructive chain tail",
        rowAfterClaim?.order_pipeline_id === deletion?.id,
        JSON.stringify(rowAfterClaim)
      );

      // ── Case 4: double-claim while rebuild is active → 409-equivalent ─────
      console.log("\n=== 4. Double-claim while rebuilding → unlock_already_in_flight ===");
      const doubleClaimResult = await claimUnlock(knex, billId, {
        reason: "verify: case 4 — double claim",
        actorId: "user_verify_actor_2",
      });
      assert(
        "claimUnlock returns unlock_already_in_flight",
        !doubleClaimResult.ok && doubleClaimResult.code === "unlock_already_in_flight",
        JSON.stringify(doubleClaimResult)
      );

      console.log(
        `\n=== RESULT: ${passed} passed, ${failed} failed ===${failed ? " ❌" : " ✅"}\n`
      );
    } finally {
      // Never persist anything this script touched.
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
