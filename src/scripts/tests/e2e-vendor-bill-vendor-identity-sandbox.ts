/**
 * e2e-vendor-bill-vendor-identity-sandbox.ts
 *
 * SANDBOX ONLY (pg :5499). Exercises the VB-1148 fix end to end against a real
 * database: the enqueue must resolve the vendor's QuickBooks ListID from the
 * LIVE vendor when the bill froze a `pending_` placeholder, and must refuse to
 * queue at all while that placeholder is still all there is.
 *
 * THE FIXTURE IS BUILT, NOT FOUND. Hunting production-shaped rows for a state
 * that lasts ~1 minute is how a test ends up asserting nothing; every row here
 * is created by this script and deleted at the end.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/tests/e2e-vendor-bill-vendor-identity-sandbox.ts
 */
import { randomUUID } from "crypto";
import { Client } from "pg";

import { enqueueQbVendorBillAdd } from "../../lib/purchase-orders/qb-vendor-bill-enqueue";

const SANDBOX_URL = "postgresql://postgres:sandbox@localhost:5499/medusa";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // Fail closed on the destination: this script writes, and it must never be
  // pointed at anything but the sandbox.
  if (!SANDBOX_URL.includes("localhost:5499")) {
    throw new Error("refusing to run against a non-sandbox database");
  }
  process.env.QB_VENDOR_BILL_MODE = "bill";

  const client = new Client({ connectionString: SANDBOX_URL });
  await client.connect();

  // `enqueuePurchaseQbOperation` REFUSES to run outside a transaction — the
  // dependency chain's UPSERT is the serialization point, so a shim without
  // `transaction` is not a lighter version of the real caller, it is a
  // different one. BEGIN/COMMIT on the same client reproduces it faithfully.
  const makeKnex = (): {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    transaction: <T>(cb: (trx: ReturnType<typeof makeKnex>) => Promise<T>) => Promise<T>;
  } => ({
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      const r = await client.query(pgSql, bindings as never[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    transaction: async <T,>(cb: (trx: ReturnType<typeof makeKnex>) => Promise<T>): Promise<T> => {
      await client.query("BEGIN");
      try {
        const out = await cb(makeKnex());
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
  });
  const knex = makeKnex();

  const tag = randomUUID().slice(0, 8);
  const pendingVendorId = `qbvnd_e2e_pend_${tag}`;
  const stableVendorId = `qbvnd_e2e_stab_${tag}`;
  const pendingBillId = `vb_e2e_pend_${tag}`;
  const stableBillId = `vb_e2e_stab_${tag}`;
  const PLACEHOLDER = `pending_${Date.now()}_${tag}`;
  const REAL_LIST_ID = `E2E000${tag}-1788464542`;
  const FROZEN_LIST_ID = `E2EFRZ${tag}-1700000000`;
  const LIVE_DIFFERENT = `E2ELIV${tag}-1799999999`;

  const createdBills: string[] = [];
  const createdVendors: string[] = [];

  try {
    // ── Fixture A: vendor still carrying its placeholder + a bill that froze it
    await knex.raw(
      `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, is_active)
       VALUES (?, ?, ?, ?, true)`,
      [pendingVendorId, PLACEHOLDER, `E2E PENDING ${tag}`, `E2E PENDING ${tag}`]
    );
    createdVendors.push(pendingVendorId);

    await knex.raw(
      `INSERT INTO vendor_bill
         (id, status, bill_type, number, reference_id, vendor_id,
          vendor_name_snapshot, vendor_qb_list_id_snapshot, document_date, due_date)
       VALUES (?, 'confirmed', 'service', ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        pendingBillId,
        `VB-E2E-${tag}`,
        `E2E-REF-${tag}`,
        pendingVendorId,
        `E2E PENDING ${tag}`,
        PLACEHOLDER,
      ]
    );
    createdBills.push(pendingBillId);

    await knex.raw(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, sku, description, qty, unit_cost_cents,
          landed_unit_cost_cents, qb_account_list_id, qb_account_full_name, qb_account_type)
       VALUES (?, ?, 'qb_account', ?, ?, 1, 12345, 12345, ?, ?, 'CostOfGoodsSold')`,
      [
        `vbl_e2e_pend_${tag}`,
        pendingBillId,
        "Commission for Sale:Referral",
        `E2E commission ${tag}`,
        "8000018A-1786738459",
        "Commission for Sale:Referral",
      ]
    );

    console.log("\n§1 — a placeholder that has NOT synced fails closed");
    const blocked = await enqueueQbVendorBillAdd(knex, pendingBillId);
    check(
      "the enqueue refuses to queue",
      blocked.queued === false,
      JSON.stringify(blocked)
    );
    check(
      "and says the vendor has not synced",
      blocked.queued === false && /pending/i.test(blocked.reason),
      JSON.stringify(blocked)
    );
    const noRow = await knex.raw(
      `SELECT count(*)::int AS n FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = ?`,
      [pendingBillId]
    );
    // The whole point of failing closed: no frozen-payload row is manufactured.
    check(
      "NO pipeline row was created",
      Number((noRow.rows[0] as { n: number }).n) === 0
    );

    console.log("\n§2 — once QuickBooks assigns the real ListID, it resolves LIVE");
    await knex.raw(`UPDATE qb_vendor SET qb_list_id = ? WHERE id = ?`, [
      REAL_LIST_ID,
      pendingVendorId,
    ]);
    const queued = await enqueueQbVendorBillAdd(knex, pendingBillId);
    check("the enqueue queues", queued.queued === true, JSON.stringify(queued));

    if (queued.queued) {
      const row = await knex.raw(
        `SELECT payload->>'vendor_qb_list_id' AS list_id, intent, status
           FROM qb_vendor_bill_pipeline WHERE id = ?`,
        [queued.pipelineRowId]
      );
      const p = row.rows[0] as { list_id: string; intent: string; status: string };
      check(
        "the payload carries the REAL ListID, not the placeholder",
        p.list_id === REAL_LIST_ID,
        p.list_id
      );
      check("intent is add", p.intent === "add", p.intent);

      const stamped = await knex.raw(
        `SELECT vendor_qb_list_id_snapshot AS s FROM vendor_bill WHERE id = ?`,
        [pendingBillId]
      );
      // The document must stop carrying a dead id, or every later read of the
      // bill still shows the placeholder.
      check(
        "the bill's snapshot was RE-STAMPED with the real ListID",
        (stamped.rows[0] as { s: string }).s === REAL_LIST_ID,
        (stamped.rows[0] as { s: string }).s
      );

      await knex.raw(`DELETE FROM qb_vendor_bill_pipeline WHERE id = ?`, [
        queued.pipelineRowId,
      ]);
    }

    console.log("\n§3 — NEGATIVE: a valid snapshot is never re-targeted");
    await knex.raw(
      `INSERT INTO qb_vendor (id, qb_list_id, full_name, name, is_active)
       VALUES (?, ?, ?, ?, true)`,
      [stableVendorId, LIVE_DIFFERENT, `E2E STABLE ${tag}`, `E2E STABLE ${tag}`]
    );
    createdVendors.push(stableVendorId);

    await knex.raw(
      `INSERT INTO vendor_bill
         (id, status, bill_type, number, reference_id, vendor_id,
          vendor_name_snapshot, vendor_qb_list_id_snapshot, document_date, due_date)
       VALUES (?, 'confirmed', 'service', ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        stableBillId,
        `VB-E2E-S-${tag}`,
        `E2E-REF-S-${tag}`,
        stableVendorId,
        `E2E STABLE ${tag}`,
        FROZEN_LIST_ID,
      ]
    );
    createdBills.push(stableBillId);

    await knex.raw(
      `INSERT INTO vendor_bill_line
         (id, vendor_bill_id, line_type, sku, description, qty, unit_cost_cents,
          landed_unit_cost_cents, qb_account_list_id, qb_account_full_name, qb_account_type)
       VALUES (?, ?, 'qb_account', ?, ?, 1, 5000, 5000, ?, ?, 'CostOfGoodsSold')`,
      [
        `vbl_e2e_stab_${tag}`,
        stableBillId,
        "Commission for Sale:Referral",
        `E2E stable ${tag}`,
        "8000018A-1786738459",
        "Commission for Sale:Referral",
      ]
    );

    const stable = await enqueueQbVendorBillAdd(knex, stableBillId);
    check("the enqueue queues", stable.queued === true, JSON.stringify(stable));
    if (stable.queued) {
      const row = await knex.raw(
        `SELECT payload->>'vendor_qb_list_id' AS list_id
           FROM qb_vendor_bill_pipeline WHERE id = ?`,
        [stable.pipelineRowId]
      );
      const listId = (row.rows[0] as { list_id: string }).list_id;
      // If this ever reads LIVE_DIFFERENT, the fix became "always use live" and
      // every historical bill silently re-targets to whatever the vendor is now.
      check(
        "the payload uses the FROZEN snapshot, not the live vendor",
        listId === FROZEN_LIST_ID,
        listId
      );
      const untouched = await knex.raw(
        `SELECT vendor_qb_list_id_snapshot AS s FROM vendor_bill WHERE id = ?`,
        [stableBillId]
      );
      check(
        "and the snapshot was NOT rewritten",
        (untouched.rows[0] as { s: string }).s === FROZEN_LIST_ID,
        (untouched.rows[0] as { s: string }).s
      );
      await knex.raw(`DELETE FROM qb_vendor_bill_pipeline WHERE id = ?`, [
        stable.pipelineRowId,
      ]);
    }
  } finally {
    for (const id of createdBills) {
      await knex.raw(`DELETE FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = ?`, [id]);
      await knex.raw(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = ?`, [id]);
      await knex.raw(`DELETE FROM vendor_bill WHERE id = ?`, [id]);
    }
    for (const id of createdVendors) {
      await knex.raw(`DELETE FROM qb_vendor WHERE id = ?`, [id]);
    }
    console.log("\n  cleanup: fixture removed");
    await client.end();
  }

  console.log(failures === 0 ? "\nOK — 10/10\n" : `\nFAILED — ${failures} check(s)\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
