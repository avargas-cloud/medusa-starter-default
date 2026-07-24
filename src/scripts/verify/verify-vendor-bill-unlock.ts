/**
 * verify-vendor-bill-unlock.ts
 *
 * Verifies `claimUnlock` (`lib/purchase-orders/qb-vendor-bill-unlock.ts`) —
 * the guard/claim logic shared by `POST /admin/vendor-bills/:id/qb-unlock`
 * (item 1.9, `docs/VENDOR_BILL_QB_SYNC_PLAN.md` §6.2/§9, SIMPLIFIED MVP).
 *
 * Cases:
 *   1. Bill not synced (`qb_txn_id IS NULL`) → `bill_not_synced`.
 *   2. Synced bill with a `synced` pipeline row → claim succeeds, row flips
 *      to `intent='unlock_rebuild'`/`status='waiting'`, `snapshot` carries
 *      the audit trail (reason/actor/previous_payload).
 *   3. Same bill claimed again while still `unlock_rebuild` →
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
  return {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      const res = await client.query(pgSql, bindings as never[]);
      return { rows: res.rows, rowCount: res.rowCount ?? undefined };
    },
  };
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
      !(await tableExists(client, "vendor_bill"))
    ) {
      console.log(
        "\n⏭  SKIP: `qb_vendor_bill_pipeline`/`vendor_bill` do not exist in this " +
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
      const previousPayload = { po_id: "po_verify", item_lines: [{ sku: "SKU-1" }] };

      // ── Seed a minimal synthetic vendor_bill (no FK constraints outside
      // purchase_order_receipt_id, left NULL) ────────────────────────────────
      await client.query(
        `INSERT INTO vendor_bill
           (id, status, bill_type, purchase_order_id, qb_txn_id)
         VALUES ($1, 'draft', 'regular', NULL, NULL)`,
        [billId]
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
      await client.query(
        `INSERT INTO qb_vendor_bill_pipeline
           (id, vendor_bill_id, purchase_order_id, status, intent, qb_txn_id, payload)
         VALUES ($1, $2, NULL, 'synced', 'add', $3, $4::jsonb)`,
        [pipelineRowId, billId, fakeTxnId, JSON.stringify(previousPayload)]
      );

      // ── Case 2: synced bill → claim succeeds, row flips + audits ──────────
      console.log("\n=== 2. Synced bill → claim succeeds (intent flips, snapshot audited) ===");
      const claimResult = await claimUnlock(knex, billId, {
        reason: "verify: case 2 — testing unlock",
        actorId: "user_verify_actor",
      });
      assert(
        "claimUnlock returns ok:true with the existing pipeline row id",
        claimResult.ok === true && claimResult.pipelineRowId === pipelineRowId,
        JSON.stringify(claimResult)
      );

      const rowAfterClaim = (
        await client.query(
          `SELECT intent, status, qb_operation_id, retries, snapshot
             FROM qb_vendor_bill_pipeline WHERE id = $1`,
          [pipelineRowId]
        )
      ).rows[0];
      assert(
        "row flipped to intent='unlock_rebuild'",
        rowAfterClaim?.intent === "unlock_rebuild",
        JSON.stringify(rowAfterClaim)
      );
      assert("row flipped to status='waiting'", rowAfterClaim?.status === "waiting");
      assert("qb_operation_id cleared", rowAfterClaim?.qb_operation_id === null);
      assert("retries reset to 0", rowAfterClaim?.retries === 0);
      assert(
        "snapshot carries unlock_reason",
        rowAfterClaim?.snapshot?.unlock_reason === "verify: case 2 — testing unlock",
        JSON.stringify(rowAfterClaim?.snapshot)
      );
      assert(
        "snapshot carries unlocked_by",
        rowAfterClaim?.snapshot?.unlocked_by === "user_verify_actor"
      );
      assert(
        "snapshot carries unlocked_at",
        typeof rowAfterClaim?.snapshot?.unlocked_at === "string"
      );
      assert(
        "snapshot.previous_payload matches the pre-unlock payload",
        JSON.stringify(rowAfterClaim?.snapshot?.previous_payload) ===
          JSON.stringify(previousPayload),
        JSON.stringify(rowAfterClaim?.snapshot?.previous_payload)
      );

      // ── Case 3: double-claim while still unlock_rebuild → 409-equivalent ──
      console.log("\n=== 3. Double-claim while unlock_rebuild → unlock_already_in_flight ===");
      const doubleClaimResult = await claimUnlock(knex, billId, {
        reason: "verify: case 3 — double claim",
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
