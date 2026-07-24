/**
 * verify-po-qb-sync-gate.ts
 *
 * Verifies the dependency gate that stops an ItemReceipt from being dispatched
 * to QuickBooks while its Purchase Order still owes QB a change.
 *
 * Incident under test (RCP-1143 / PO-1113, 2026-07-23):
 *   PO-1113 was edited in Medusa (SUP-PL-05-W-3000 went 40 → 42, SUP-C2R4N70W10CT
 *   5 → 3, one line removed). The PurchaseOrderMod failed in QB, so QuickBooks
 *   kept the pre-edit quantities. The receipt was then dispatched with the NEW
 *   quantities and QB rejected it:
 *     "Error 3060 ... quantity 42 ... This quantity exceeds what you ordered."
 *   Nothing ordered the two independent pollers, so the receipt overtook the PO
 *   edit it depended on. checkPoQbSyncGate() is that ordering.
 *
 * Read-only: this script only SELECTs. It asserts the gate's verdict against
 * live pipeline rows plus synthetic in-memory cases.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-po-qb-sync-gate.ts
 *      (needs DATABASE_URL — `set -a; source .env; set +a` first)
 */

import { Client } from "pg";
import {
  checkPoQbSyncGate,
  type KnexLike,
} from "../../lib/purchase-orders/po-qb-sync-gate";

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

/** Adapts a pg Client to the `?`-placeholder knex.raw shape the gate expects. */
function asKnexLike(client: Client): KnexLike {
  return {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      const res = await client.query(pgSql, bindings as never[]);
      return { rows: res.rows };
    },
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  const knex = asKnexLike(client);

  try {
    console.log("\n=== 1. Unknown purchase order → not blocked ===");
    const unknown = await checkPoQbSyncGate(knex, "po_does_not_exist");
    assert(
      "no pipeline row ⇒ gate open (receipt carries no LinkToTxn)",
      unknown.blocked === false
    );

    console.log("\n=== 2. A synced PO → not blocked ===");
    const syncedRow = await client.query<{ purchase_order_id: string }>(
      `SELECT purchase_order_id FROM qb_purchase_order_pipeline
        WHERE status = 'synced' AND deleted_at IS NULL LIMIT 1`
    );
    if (syncedRow.rowCount) {
      const poId = syncedRow.rows[0].purchase_order_id;
      const gate = await checkPoQbSyncGate(knex, poId);
      assert(`synced PO ${poId} ⇒ gate open`, gate.blocked === false);
    } else {
      console.log("  ⏭  no synced PO pipeline rows in this database");
    }

    console.log("\n=== 3. A PO with an unsynced change → blocked ===");
    const stuck = await client.query<{
      purchase_order_id: string;
      status: string;
      number: string | null;
    }>(
      `SELECT p.purchase_order_id, p.status, po.number
         FROM qb_purchase_order_pipeline p
         LEFT JOIN purchase_order po ON po.id = p.purchase_order_id
        WHERE p.status <> 'synced' AND p.deleted_at IS NULL
        LIMIT 1`
    );
    if (stuck.rowCount) {
      const { purchase_order_id: poId, status, number } = stuck.rows[0];
      const gate = await checkPoQbSyncGate(knex, poId);
      assert(
        `${number ?? poId} (status='${status}') ⇒ gate CLOSED`,
        gate.blocked === true,
        JSON.stringify(gate)
      );
      if (gate.blocked) {
        assert(
          "terminal flag matches failed_permanent",
          gate.terminal === (status === "failed_permanent")
        );
        assert(
          "reason names the PO and the pipeline status",
          gate.reason.includes(number ?? poId) && gate.reason.includes(status)
        );
        console.log(`     reason: ${gate.reason}`);
      }
    } else {
      console.log(
        "  ⏭  every PO pipeline row is synced — nothing to block right now"
      );
    }

    console.log("\n=== 4. Receipts that would have been held ===");
    // Any receipt still owing QB an ADD whose PO is not synced. Before the gate
    // these were dispatched anyway and came back with QB error 3060.
    const wouldHold = await client.query<{
      receipt_number: string | null;
      po_number: string | null;
      receipt_status: string;
      po_status: string;
    }>(
      `SELECT r.number AS receipt_number,
              po.number AS po_number,
              irp.status AS receipt_status,
              pop.status AS po_status
         FROM qb_item_receipt_pipeline irp
         JOIN qb_purchase_order_pipeline pop
           ON pop.purchase_order_id = irp.purchase_order_id
          AND pop.deleted_at IS NULL
         LEFT JOIN purchase_order_receipt r ON r.id = irp.purchase_order_receipt_id
         LEFT JOIN purchase_order po ON po.id = irp.purchase_order_id
        WHERE irp.status <> 'synced'
          AND pop.status <> 'synced'
          AND irp.deleted_at IS NULL`
    );
    if (wouldHold.rowCount) {
      for (const r of wouldHold.rows) {
        console.log(
          `  • ${r.receipt_number ?? "?"} (${r.receipt_status}) on ${r.po_number ?? "?"} (PO ${r.po_status}) — would now be HELD, not rejected by QB`
        );
      }
    } else {
      console.log("  (none right now)");
    }

    console.log(
      `\n=== RESULT: ${passed} passed, ${failed} failed ===${failed ? " ❌" : " ✅"}\n`
    );
  } finally {
    await client.end();
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
