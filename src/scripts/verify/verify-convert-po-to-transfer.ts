/**
 * scripts/verify/verify-convert-po-to-transfer.ts
 *
 * End-to-end smoke test for POST /admin/purchase-orders/:id/convert-to-transfer.
 *
 * Picks a real submitted PO that has 0 receipts and no linked IT, calls the
 * endpoint, verifies the resulting state, then ROLLS BACK by soft-deleting the
 * created IT + restoring China reservations to the original state.
 *
 * Run: npx tsx src/scripts/verify/verify-convert-po-to-transfer.ts
 *      npx tsx src/scripts/verify/verify-convert-po-to-transfer.ts PO-1037
 */

import "dotenv/config";
import { Client } from "pg";

const BACKEND_URL = process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000";
const CHINA_LOC = "sloc_01KQ14C1CFX30EDD722BF87HDM";

function pass(msg: string) {
  console.log(`  ✅  ${msg}`);
}
function fail(msg: string): never {
  console.error(`  ❌  ${msg}`);
  process.exit(1);
}
function info(msg: string) {
  console.log(`  ℹ   ${msg}`);
}

async function getAdminToken(): Promise<string> {
  const email = process.env.TEST_ADMIN_EMAIL ?? "a.vargas@ecopowertech.com";
  const password =
    process.env.TEST_ADMIN_PASSWORD ?? process.env.MEDUSA_ADMIN_PASSWORD ?? "";
  if (!password) {
    fail("Set TEST_ADMIN_PASSWORD (or MEDUSA_ADMIN_PASSWORD) in .env.");
  }
  const res = await fetch(`${BACKEND_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) fail(`Auth failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) fail("No token in auth response.");
  return data.token!;
}

async function callConvert(
  token: string,
  poId: string
): Promise<{ status: number; body: any }> {
  const res = await fetch(
    `${BACKEND_URL}/admin/purchase-orders/${poId}/convert-to-transfer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    }
  );
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

interface CandidatePo {
  id: string;
  number: string | null;
  total_units_received: number;
  vendor_name_snapshot: string | null;
}

async function pickCandidatePo(
  db: Client,
  preferredNumber?: string
): Promise<CandidatePo> {
  if (preferredNumber) {
    const r = await db.query<CandidatePo>(
      `SELECT po.id, po.number, po.total_units_received, po.vendor_name_snapshot
         FROM purchase_order po
        WHERE po.number = $1 AND po.deleted_at IS NULL
        LIMIT 1`,
      [preferredNumber]
    );
    if (r.rows.length === 0)
      fail(`Preferred PO ${preferredNumber} not found.`);
    return r.rows[0]!;
  }

  // Auto-pick: submitted PO with no receipts + no active IT linked.
  const r = await db.query<CandidatePo>(
    `SELECT po.id, po.number, po.total_units_received, po.vendor_name_snapshot
       FROM purchase_order po
       LEFT JOIN inventory_transfer it
         ON it.linked_purchase_order_id = po.id
        AND it.status <> 'voided'
        AND it.deleted_at IS NULL
      WHERE po.status IN ('submitted', 'partially_received')
        AND po.total_units_received = 0
        AND po.deleted_at IS NULL
        AND it.id IS NULL
      ORDER BY po.created_at DESC
      LIMIT 1`
  );
  if (r.rows.length === 0)
    fail("No candidate PO found (submitted, 0 receipts, no linked IT).");
  return r.rows[0]!;
}

interface ItRow {
  id: string;
  number: string | null;
  status: string;
  total_lines: number;
  total_units: number;
}

async function loadIt(db: Client, transferId: string): Promise<ItRow | null> {
  const r = await db.query<ItRow>(
    `SELECT id, number, status, total_lines, total_units
       FROM inventory_transfer WHERE id = $1 AND deleted_at IS NULL`,
    [transferId]
  );
  return r.rows[0] ?? null;
}

async function countReservations(
  db: Client,
  transferId: string
): Promise<number> {
  const r = await db.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
       FROM reservation_item
      WHERE metadata->>'inventory_transfer_id' = $1
        AND deleted_at IS NULL`,
    [transferId]
  );
  return r.rows[0]?.cnt ?? 0;
}

async function totalChinaReservedForIt(
  db: Client,
  transferId: string
): Promise<number> {
  const r = await db.query<{ s: number }>(
    `SELECT COALESCE(SUM(quantity), 0)::int AS s
       FROM reservation_item
      WHERE metadata->>'inventory_transfer_id' = $1
        AND location_id = $2
        AND deleted_at IS NULL`,
    [transferId, CHINA_LOC]
  );
  return r.rows[0]?.s ?? 0;
}

async function rollback(
  db: Client,
  transferId: string,
  inventoryItemIds: string[]
): Promise<void> {
  info(`Rolling back: soft-deleting IT ${transferId} and its reservations…`);
  // Pull the reservations + qty so we can decrement reserved_quantity to match
  const resRows = await db.query<{
    id: string;
    inventory_item_id: string;
    quantity: number;
  }>(
    `SELECT id, inventory_item_id, quantity
       FROM reservation_item
      WHERE metadata->>'inventory_transfer_id' = $1
        AND deleted_at IS NULL`,
    [transferId]
  );

  for (const row of resRows.rows) {
    await db.query(
      `UPDATE reservation_item SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
    await db.query(
      `UPDATE inventory_level
          SET reserved_quantity = GREATEST(0, reserved_quantity - $1),
              raw_reserved_quantity = jsonb_build_object(
                'value', GREATEST(0, reserved_quantity - $1)::text,
                'precision', 20
              ),
              updated_at = NOW()
        WHERE inventory_item_id = $2
          AND location_id = $3
          AND deleted_at IS NULL`,
      [row.quantity, row.inventory_item_id, CHINA_LOC]
    );
  }

  await db.query(
    `UPDATE inventory_transfer_line SET deleted_at = NOW() WHERE transfer_id = $1`,
    [transferId]
  );
  await db.query(
    `UPDATE inventory_transfer SET deleted_at = NOW() WHERE id = $1`,
    [transferId]
  );

  void inventoryItemIds; // logged for future per-item assertions if needed
  pass(`Rolled back ${resRows.rows.length} reservation(s) + IT marked deleted`);
}

async function main() {
  console.log("\n🔬  verify-convert-po-to-transfer\n");
  const arg = process.argv[2] ?? undefined;
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    // 1. Pick candidate
    const po = await pickCandidatePo(db, arg);
    info(
      `Candidate PO: ${po.number} (${po.id}), vendor=${po.vendor_name_snapshot ?? "?"}, received=${po.total_units_received}`
    );

    // 2. Snapshot China reserved totals for the variants this PO touches
    const lineRows = await db.query<{
      inventory_item_id: string;
      reserved_before: number;
    }>(
      `SELECT DISTINCT pol.inventory_item_id,
              COALESCE(il.reserved_quantity, 0)::int AS reserved_before
         FROM purchase_order_line pol
         LEFT JOIN inventory_level il
           ON il.inventory_item_id = pol.inventory_item_id
          AND il.location_id = $2
          AND il.deleted_at IS NULL
        WHERE pol.purchase_order_id = $1 AND pol.deleted_at IS NULL`,
      [po.id, CHINA_LOC]
    );
    const reservedBefore = new Map(
      lineRows.rows.map((r) => [r.inventory_item_id, r.reserved_before])
    );
    info(`Tracked ${reservedBefore.size} inventory items.`);

    // 3. Auth
    const token = await getAdminToken();
    pass("Authenticated");

    // 4. Happy path
    info("Calling convert-to-transfer (happy path)…");
    const first = await callConvert(token, po.id);
    if (first.status !== 201) {
      fail(`Expected 201, got ${first.status}: ${JSON.stringify(first.body)}`);
    }
    const transferId = first.body.transfer?.id as string;
    if (!transferId) fail("Response missing transfer.id");
    pass(`IT created: ${first.body.transfer.number} (${transferId})`);

    // 5. Verify DB state
    const it = await loadIt(db, transferId);
    if (!it) fail("IT not found in DB after create");
    if (it.status !== "confirmed")
      fail(`Expected status='confirmed', got '${it.status}'`);
    pass(`IT.status=confirmed, total_lines=${it.total_lines}, total_units=${it.total_units}`);

    const resCount = await countReservations(db, transferId);
    if (resCount === 0) fail("No China reservations created");
    pass(`${resCount} China reservation(s) created`);

    const reservedTotal = await totalChinaReservedForIt(db, transferId);
    info(`Total China reserved by this IT: ${reservedTotal}`);
    if (reservedTotal !== it.total_units) {
      fail(
        `Reservation total ${reservedTotal} ≠ IT.total_units ${it.total_units}`
      );
    }
    pass("Reservation total matches IT.total_units");

    // 6. Second call must 409 already_linked
    info("Calling again — expecting 409 already_linked…");
    const second = await callConvert(token, po.id);
    if (second.status !== 409 || second.body?.code !== "already_linked") {
      fail(
        `Expected 409 already_linked, got ${second.status} ${JSON.stringify(second.body)}`
      );
    }
    pass("Second call rejected with already_linked");

    // 7. Rollback so the PO stays usable + reservations cleared
    const touched = Array.from(reservedBefore.keys());
    await rollback(db, transferId, touched);

    // 8. Verify reserved levels are back to baseline (idempotency check)
    for (const [iid, before] of reservedBefore.entries()) {
      const after = await db.query<{ q: number }>(
        `SELECT COALESCE(reserved_quantity, 0)::int AS q
           FROM inventory_level
          WHERE inventory_item_id = $1 AND location_id = $2 AND deleted_at IS NULL`,
        [iid, CHINA_LOC]
      );
      const q = after.rows[0]?.q ?? 0;
      if (q !== before) {
        fail(
          `Reserved drift on ${iid}: before=${before}, after rollback=${q}`
        );
      }
    }
    pass("All China reserved_quantity restored to baseline");

    console.log("\n✅  All checks passed.\n");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
