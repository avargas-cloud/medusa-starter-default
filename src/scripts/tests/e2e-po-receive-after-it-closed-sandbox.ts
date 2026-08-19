/**
 * e2e-po-receive-after-it-closed-sandbox.ts — PO receipts that land AFTER the
 * linked Inventory Transfer already closed.
 *
 * SANDBOX ONLY: talks to http://localhost:9099 and postgres :5499. Refuses to
 * run against anything else. Everything goes over real HTTP against the admin
 * API; the DB is only read, for assertions.
 *
 * What it pins down, in three phases:
 *
 *   Phase 1 — a PO to the China agent is fully received (IT → 'received'), then
 *     EDITED: one line's qty raised and a brand-new line added. The mirror has
 *     to follow the edit onto the closed transfer and REOPEN it, or the units
 *     that arrive next never leave China.
 *       (a) the IT line rises to the new qty
 *       (b) a NEW IT line appears for the new PO line
 *       (c) the IT drops back to 'shipped' with received_at = NULL
 *       (d) the IT header totals follow its lines
 *     Then the PO is received again and China is debited for exactly the NEW
 *     units. Finally POST /inventory-transfers/:id/receive must 409 with
 *     `linked_po_receive_required`.
 *
 *   Phase 2 — isolates the `findLinkedTransfer(['shipped','received'])` half of
 *     the fix: a transfer sitting at 'received' while its PO still has units
 *     inbound. With the mirror fix in place there is no longer any HTTP path
 *     that CREATES that state (the PO edit reopens the transfer, and the IT
 *     receive route now 409s), so the row is SEEDED directly — it models the
 *     data already in production: 56 units of phantom China stock across
 *     RCP-1106 / RCP-1142 / RCP-1198, transfers closed before the fix existed.
 *     Everything under test still runs over HTTP; only the legacy row is
 *     planted. The old 'shipped'-only lookup turns that receipt into a silent
 *     no-op: China never debited, reservation never released, qty_received
 *     never bumped.
 *
 *   Phase 3 — POSITIVE CONTROL: the ordinary open-transfer flow (receive
 *     partially → edit the PO → receive the rest) still behaves exactly as
 *     before. Without this, a fix that broke the normal path would pass.
 *
 * Every stock assertion reads `stocked_quantity` AND `raw_stocked_quantity`
 * (and the reserved pair) together and fails if they disagree: Medusa reads the
 * raw_* BigNumber, so moving one column without the other is the historical bug
 * of this area.
 *
 * Run:  ./node_modules/.bin/tsx src/scripts/tests/e2e-po-receive-after-it-closed-sandbox.ts
 */

import { Client } from "pg";

const API = "http://localhost:9099";
const DB_URL = "postgresql://postgres:sandbox@localhost:5499/medusa";
const CHINA_LOC =
  process.env.CHINA_WAREHOUSE_LOCATION_ID ?? "sloc_01KQ14C1CFX30EDD722BF87HDM";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface FetchResult {
  status: number;
  body: Record<string, unknown>;
}

let TOKEN: string | null = null;
let PIN_HEADER: Record<string, string> = {};

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<FetchResult> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...PIN_HEADER,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

function brief(r: FetchResult): string {
  return `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
}

interface Fixture {
  variant_id: string;
  inventory_item_id: string;
  sku: string;
  title: string;
}

function poLine(f: Fixture, qty: number, cents: number, order: number) {
  return {
    product_variant_id: f.variant_id,
    inventory_item_id: f.inventory_item_id,
    sku_snapshot: f.sku,
    description_snapshot: f.title || f.sku,
    qty_ordered: qty,
    unit_cost_cents: cents,
    line_order: order,
  };
}

// ── DB readers ────────────────────────────────────────────────────────────

interface ChinaLevel {
  stocked: number;
  rawStocked: number;
  reserved: number;
  rawReserved: number;
}

/**
 * Reads the numeric column AND its raw_* BigNumber twin in one shot. Any assert
 * that uses this must also assert `lockstep()` — Medusa's inventory module (and
 * therefore MeiliSearch) reads the raw_* side, so a write that moves only one
 * of the two is a silent desync, not a rounding detail.
 */
async function chinaLevel(db: Client, inventoryItemId: string): Promise<ChinaLevel> {
  const r = await db.query(
    `SELECT stocked_quantity,
            reserved_quantity,
            raw_stocked_quantity->>'value'  AS raw_stocked,
            raw_reserved_quantity->>'value' AS raw_reserved
       FROM inventory_level
      WHERE inventory_item_id = $1 AND location_id = $2 AND deleted_at IS NULL`,
    [inventoryItemId, CHINA_LOC]
  );
  const row = r.rows[0] as
    | {
        stocked_quantity: string | number;
        reserved_quantity: string | number;
        raw_stocked: string | null;
        raw_reserved: string | null;
      }
    | undefined;
  if (!row) throw new Error(`no China inventory_level for ${inventoryItemId}`);
  return {
    stocked: Number(row.stocked_quantity),
    rawStocked: Number(row.raw_stocked),
    reserved: Number(row.reserved_quantity),
    rawReserved: Number(row.raw_reserved),
  };
}

function lockstep(l: ChinaLevel): boolean {
  return l.stocked === l.rawStocked && l.reserved === l.rawReserved;
}

function levelStr(l: ChinaLevel): string {
  return `stocked=${l.stocked}/raw=${l.rawStocked} reserved=${l.reserved}/raw=${l.rawReserved}`;
}

/** Asserts an exact stocked value AND that the numeric/raw pair agree. */
async function checkStock(
  db: Client,
  label: string,
  inventoryItemId: string,
  expected: number
): Promise<ChinaLevel> {
  const lvl = await chinaLevel(db, inventoryItemId);
  check(
    `${label} — China stocked_quantity = ${expected}`,
    lvl.stocked === expected,
    levelStr(lvl)
  );
  check(
    `${label} — stocked/raw_stocked + reserved/raw_reserved in lockstep`,
    lockstep(lvl),
    levelStr(lvl)
  );
  return lvl;
}

interface TransferRow {
  id: string;
  number: string | null;
  status: string;
  received_at: string | null;
  total_lines: number;
  total_units: number;
}

async function transferRow(db: Client, id: string): Promise<TransferRow> {
  const r = await db.query(
    `SELECT id, number, status, received_at, total_lines, total_units
       FROM inventory_transfer WHERE id = $1`,
    [id]
  );
  const row = r.rows[0] as
    | {
        id: string;
        number: string | null;
        status: string;
        received_at: Date | null;
        total_lines: string | number;
        total_units: string | number;
      }
    | undefined;
  if (!row) throw new Error(`inventory_transfer ${id} not found`);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    received_at: row.received_at ? row.received_at.toISOString() : null,
    total_lines: Number(row.total_lines),
    total_units: Number(row.total_units),
  };
}

interface ItLine {
  id: string;
  purchase_order_line_id: string | null;
  product_variant_id: string;
  qty: number;
  qty_received: number;
}

async function transferLines(db: Client, id: string): Promise<ItLine[]> {
  const r = await db.query(
    `SELECT id, purchase_order_line_id, product_variant_id, qty, qty_received
       FROM inventory_transfer_line
      WHERE transfer_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC`,
    [id]
  );
  return (
    r.rows as Array<{
      id: string;
      purchase_order_line_id: string | null;
      product_variant_id: string;
      qty: string | number;
      qty_received: string | number;
    }>
  ).map((row) => ({
    id: row.id,
    purchase_order_line_id: row.purchase_order_line_id,
    product_variant_id: row.product_variant_id,
    qty: Number(row.qty),
    qty_received: Number(row.qty_received),
  }));
}

interface PoLineRow {
  id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qty_ordered: number;
  unit_cost_cents: number;
  line_order: number | null;
}

async function poLines(poId: string): Promise<PoLineRow[]> {
  const g = await api("GET", `/admin/purchase-orders/${poId}`);
  const po = g.body.purchase_order as { lines: PoLineRow[] } | undefined;
  if (!po) throw new Error(`GET purchase-order ${poId} failed: ${brief(g)}`);
  return po.lines;
}

/** Round-trips every line id so the PATCH diff-by-id never deletes a line. */
function patchPayload(
  lines: PoLineRow[],
  mutate: (l: PoLineRow) => number | undefined
): Array<Record<string, unknown>> {
  return lines.map((l) => ({
    id: l.id,
    product_variant_id: l.product_variant_id,
    inventory_item_id: l.inventory_item_id,
    sku_snapshot: l.sku_snapshot,
    description_snapshot: l.description_snapshot,
    qty_ordered: mutate(l) ?? Number(l.qty_ordered),
    unit_cost_cents: Number(l.unit_cost_cents),
    line_order: l.line_order ?? 0,
  }));
}

// ── flow helpers ──────────────────────────────────────────────────────────

interface OpenedPo {
  poId: string;
  poNumber: string | null;
  transferId: string;
}

async function createSubmitConvertShip(
  vendorId: string,
  locationId: string,
  lines: Array<Record<string, unknown>>,
  label: string
): Promise<OpenedPo> {
  const created = await api("POST", "/admin/purchase-orders", {
    vendor_id: vendorId,
    stock_location_id: locationId,
    lines,
  });
  const po = created.body.purchase_order as { id: string; number: string | null } | undefined;
  check(`${label} PO created`, created.status === 201 && !!po?.id, brief(created));
  if (!po?.id) throw new Error(`${label}: cannot continue without a PO`);

  const submitted = await api("POST", `/admin/purchase-orders/${po.id}/submit`, {});
  check(`${label} PO submitted`, submitted.status === 200, brief(submitted));

  const converted = await api(
    "POST",
    `/admin/purchase-orders/${po.id}/convert-to-transfer`,
    {}
  );
  const transfer = converted.body.transfer as { id: string; status: string } | undefined;
  check(
    `${label} converted to an Inventory Transfer (confirmed)`,
    converted.status === 201 && transfer?.status === "confirmed" && !!transfer?.id,
    brief(converted)
  );
  if (!transfer?.id) throw new Error(`${label}: cannot continue without an IT`);

  const shipped = await api(
    "POST",
    `/admin/inventory-transfers/${transfer.id}/ship`,
    {}
  );
  check(`${label} IT shipped`, shipped.status === 200, brief(shipped));

  return { poId: po.id, poNumber: po.number, transferId: transfer.id };
}

// ── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!API.includes("localhost:9099")) {
    throw new Error("refusing: API is not the sandbox backend (:9099)");
  }
  if (!DB_URL.includes(":5499/")) {
    throw new Error("refusing: DB_URL is not the sandbox database (:5499)");
  }
  const db = new Client({ connectionString: DB_URL });
  await db.connect();
  const guard = await db.query(`SELECT inet_server_port() AS port, current_database() AS db`);
  const port = String((guard.rows[0] as { port: number }).port);
  if (port !== "5432" && port !== "5499") {
    throw new Error(`refusing: connected to port ${port}, not the sandbox database`);
  }

  // ── login ───────────────────────────────────────────────────────────────
  const login = await api("POST", "/auth/user/emailpass", {
    email: "sandbox@test.com",
    password: "sandbox123",
  });
  TOKEN = (login.body.token as string | undefined) ?? null;
  if (!TOKEN) throw new Error(`sandbox login failed (${brief(login)})`);

  // Editing a non-draft PO is supervisor-PIN gated. The sandbox PIN is read
  // from the DB at runtime — the value never gets hardcoded here.
  const pinRow = (
    await db.query(
      `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store
        WHERE metadata->>'pos_supervisor_pin' IS NOT NULL LIMIT 1`
    )
  ).rows[0] as { pin: string } | undefined;
  if (!pinRow?.pin) throw new Error("sandbox store has no supervisor PIN configured");
  PIN_HEADER = { "x-supervisor-pin": pinRow.pin };

  // ── fixtures ────────────────────────────────────────────────────────────
  const vendorRow = (
    await db.query(
      `SELECT id, name FROM qb_vendor
        WHERE deleted_at IS NULL
          AND (metadata @> '{"is_china_agent": true}'::jsonb
               OR lower(metadata->>'is_china_agent') = 'true')
        ORDER BY id LIMIT 1`
    )
  ).rows[0] as { id: string; name: string } | undefined;
  if (!vendorRow) throw new Error("no China-agent vendor in the sandbox");

  const locRow = (
    await db.query(
      `SELECT id FROM stock_location
        WHERE deleted_at IS NULL AND id <> $1
        ORDER BY id LIMIT 1`,
      [CHINA_LOC]
    )
  ).rows[0] as { id: string } | undefined;
  if (!locRow) throw new Error("no destination stock_location in the sandbox");

  const fixtures = (
    await db.query(
      `SELECT DISTINCT ON (pv.id)
              pv.id AS variant_id, pvi.inventory_item_id, pv.sku,
              COALESCE(p.title, pv.sku) AS title
         FROM inventory_level il
         JOIN product_variant_inventory_item pvi
           ON pvi.inventory_item_id = il.inventory_item_id AND pvi.deleted_at IS NULL
         JOIN product_variant pv ON pv.id = pvi.variant_id AND pv.deleted_at IS NULL
         JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL
        WHERE il.location_id = $1
          AND il.deleted_at IS NULL
          AND il.stocked_quantity - il.reserved_quantity >= 60
          AND pv.sku IS NOT NULL
          AND pv.sku !~* '^special'
          AND COALESCE(p.title, '') !~* '^special'
          AND COALESCE(lower(p.metadata->>'qb_item_type'), '') NOT IN ('service','noninventory','othercharge')
          AND COALESCE(lower(pv.metadata->>'quickbooks_is_service'), '') <> 'true'
        ORDER BY pv.id
        LIMIT 5`,
      [CHINA_LOC]
    )
  ).rows as Fixture[];
  if (fixtures.length < 5) {
    throw new Error(`need 5 China fixtures, found ${fixtures.length}`);
  }
  const [fA, fB, fC, fE, fF] = fixtures as [
    Fixture, Fixture, Fixture, Fixture, Fixture
  ];

  console.log(
    `\nsandbox fixtures — vendor "${vendorRow.name}" · dest ${locRow.id}\n` +
      `  P1 A=${fA.sku} B=${fB.sku}  P2 C=${fC.sku}  P3 E=${fE.sku} F=${fF.sku}`
  );

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 1 — receive after the IT closed, via a PO edit
  // ══════════════════════════════════════════════════════════════════════
  console.log("\nPhase 1 — full receive → PO edit reopens the closed transfer");

  const baseA = await chinaLevel(db, fA.inventory_item_id);
  const baseB = await chinaLevel(db, fB.inventory_item_id);
  check("1.0 baseline levels for A and B are self-consistent",
    lockstep(baseA) && lockstep(baseB),
    `${levelStr(baseA)} | ${levelStr(baseB)}`);

  const p1 = await createSubmitConvertShip(
    vendorRow.id,
    locRow.id,
    [poLine(fA, 5, 1000, 0)],
    "1.1"
  );

  const it1Lines0 = await transferLines(db, p1.transferId);
  check("1.2 IT has exactly 1 line, qty 5", it1Lines0.length === 1 && it1Lines0[0]?.qty === 5,
    JSON.stringify(it1Lines0));
  const afterConvertA = await chinaLevel(db, fA.inventory_item_id);
  check("1.3 convert reserved 5 units of A in China (numeric + raw)",
    afterConvertA.reserved === baseA.reserved + 5 && lockstep(afterConvertA),
    `${levelStr(baseA)} → ${levelStr(afterConvertA)}`);

  const po1Lines = await poLines(p1.poId);
  const lineA = po1Lines.find((l) => l.product_variant_id === fA.variant_id);
  if (!lineA) throw new Error("PO1 line A not found");

  const recv1 = await api("POST", `/admin/purchase-orders/${p1.poId}/receive`, {
    lines: [{ po_line_id: lineA.id, qty_received_now: 5 }],
  });
  check("1.4 PO fully received", recv1.status === 200, brief(recv1));

  const it1AfterRecv = await transferRow(db, p1.transferId);
  check("1.5 IT status = 'received'", it1AfterRecv.status === "received", it1AfterRecv.status);
  check("1.6 IT received_at stamped", it1AfterRecv.received_at !== null,
    String(it1AfterRecv.received_at));
  const firstReceivedAt = it1AfterRecv.received_at;

  await checkStock(db, "1.7 A after full receive", fA.inventory_item_id, baseA.stocked - 5);
  const relA = await chinaLevel(db, fA.inventory_item_id);
  check("1.8 A's China reservation was released back to baseline",
    relA.reserved === baseA.reserved && lockstep(relA),
    `${levelStr(baseA)} → ${levelStr(relA)}`);

  const it1Lines1 = await transferLines(db, p1.transferId);
  check("1.9 IT line A qty_received = 5",
    it1Lines1[0]?.qty_received === 5, JSON.stringify(it1Lines1));

  // ── the edit that names the defect ─────────────────────────────────────
  const patch1 = await api("PATCH", `/admin/purchase-orders/${p1.poId}`, {
    lines: [
      ...patchPayload(po1Lines, (l) =>
        l.product_variant_id === fA.variant_id ? 8 : undefined
      ),
      poLine(fB, 4, 2000, 9),
    ],
  });
  check("1.10 PO edited on a closed transfer (qty 5→8 + new line B qty 4)",
    patch1.status === 200, brief(patch1));

  const po1Lines2 = await poLines(p1.poId);
  const lineA2 = po1Lines2.find((l) => l.product_variant_id === fA.variant_id);
  const lineB = po1Lines2.find((l) => l.product_variant_id === fB.variant_id);
  check("1.11 PO now carries both lines", !!lineA2 && !!lineB,
    JSON.stringify(po1Lines2.map((l) => [l.sku_snapshot, l.qty_ordered])));
  if (!lineA2 || !lineB) throw new Error("PO1 lines missing after the edit");

  const it1Lines2 = await transferLines(db, p1.transferId);
  const itA = it1Lines2.find((l) => l.product_variant_id === fA.variant_id);
  const itB = it1Lines2.find((l) => l.product_variant_id === fB.variant_id);

  // (a)
  check("1.12 (a) the IT line for A rose to the new qty (8)", itA?.qty === 8,
    JSON.stringify(it1Lines2));
  // (b)
  check("1.13 (b) a NEW IT line exists for the new PO line B",
    !!itB && itB.qty === 4 && itB.purchase_order_line_id === lineB.id,
    JSON.stringify(itB ?? null));
  // (c)
  const it1AfterPatch = await transferRow(db, p1.transferId);
  check("1.14 (c) the IT reopened to 'shipped'",
    it1AfterPatch.status === "shipped", it1AfterPatch.status);
  check("1.15 (c) received_at cleared to NULL",
    it1AfterPatch.received_at === null, String(it1AfterPatch.received_at));
  // (d)
  check("1.16 (d) IT header total_lines = 2 and total_units = 12",
    it1AfterPatch.total_lines === 2 && it1AfterPatch.total_units === 12,
    `total_lines=${it1AfterPatch.total_lines} total_units=${it1AfterPatch.total_units}`);

  // ── the second receipt: the NEW units must leave China ─────────────────
  const preRecv2A = await chinaLevel(db, fA.inventory_item_id);
  const preRecv2B = await chinaLevel(db, fB.inventory_item_id);

  const recv2 = await api("POST", `/admin/purchase-orders/${p1.poId}/receive`, {
    lines: [
      { po_line_id: lineA2.id, qty_received_now: 3 },
      { po_line_id: lineB.id, qty_received_now: 4 },
    ],
  });
  check("1.17 the new units were received on the PO", recv2.status === 200, brief(recv2));

  await checkStock(db, "1.18 A after the 2nd receipt", fA.inventory_item_id,
    preRecv2A.stocked - 3);
  await checkStock(db, "1.19 B after the 2nd receipt", fB.inventory_item_id,
    preRecv2B.stocked - 4);
  await checkStock(db, "1.20 A total drawdown vs. the phase baseline",
    fA.inventory_item_id, baseA.stocked - 8);
  await checkStock(db, "1.21 B total drawdown vs. the phase baseline",
    fB.inventory_item_id, baseB.stocked - 4);

  const endA = await chinaLevel(db, fA.inventory_item_id);
  const endB = await chinaLevel(db, fB.inventory_item_id);
  check("1.22 every China reservation of this transfer is released",
    endA.reserved === baseA.reserved && endB.reserved === baseB.reserved,
    `A ${baseA.reserved}→${endA.reserved} · B ${baseB.reserved}→${endB.reserved}`);

  const it1Lines3 = await transferLines(db, p1.transferId);
  const itA3 = it1Lines3.find((l) => l.product_variant_id === fA.variant_id);
  const itB3 = it1Lines3.find((l) => l.product_variant_id === fB.variant_id);
  check("1.23 IT line qty_received is up to date (A=8, B=4)",
    itA3?.qty_received === 8 && itB3?.qty_received === 4, JSON.stringify(it1Lines3));

  const it1End = await transferRow(db, p1.transferId);
  check("1.24 the IT closed again ('received')", it1End.status === "received", it1End.status);
  check("1.25 received_at was re-stamped for the new arrival",
    it1End.received_at !== null && it1End.received_at !== firstReceivedAt,
    `${String(firstReceivedAt)} → ${String(it1End.received_at)}`);

  // ── the trapdoor is shut ───────────────────────────────────────────────
  const itReceive = await api(
    "POST",
    `/admin/inventory-transfers/${p1.transferId}/receive`,
    {}
  );
  check("1.26 POST /inventory-transfers/:id/receive → 409 linked_po_receive_required",
    itReceive.status === 409 && itReceive.body.code === "linked_po_receive_required",
    brief(itReceive));
  const it1AfterBlocked = await transferRow(db, p1.transferId);
  check("1.27 the 409 changed nothing on the transfer",
    it1AfterBlocked.status === it1End.status &&
      it1AfterBlocked.received_at === it1End.received_at,
    `${it1AfterBlocked.status} / ${String(it1AfterBlocked.received_at)}`);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 2 — the IT legitimately stays 'received' while units keep arriving
  // ══════════════════════════════════════════════════════════════════════
  console.log(
    "\nPhase 2 — legacy state: a closed transfer whose PO is still receiving"
  );

  const baseC = await chinaLevel(db, fC.inventory_item_id);

  const p2 = await createSubmitConvertShip(
    vendorRow.id,
    locRow.id,
    [poLine(fC, 10, 1500, 0)],
    "2.1"
  );

  const po2Lines = await poLines(p2.poId);
  const lineC = po2Lines.find((l) => l.product_variant_id === fC.variant_id);
  if (!lineC) throw new Error("PO2 line C not found");

  const recvC1 = await api("POST", `/admin/purchase-orders/${p2.poId}/receive`, {
    lines: [{ po_line_id: lineC.id, qty_received_now: 6 }],
  });
  check("2.2 partial receive (6 of 10)", recvC1.status === 200, brief(recvC1));
  await checkStock(db, "2.3 C after the partial receive", fC.inventory_item_id,
    baseC.stocked - 6);

  // SEEDED, not performed: this is the row shape production already carries —
  // a transfer closed while its PO still had units inbound, back when the IT
  // receive route would flip the status without moving any goods. Nothing else
  // in this phase is faked; the receipt below goes over real HTTP.
  await db.query(
    `UPDATE inventory_transfer
        SET status = 'received', received_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [p2.transferId]
  );
  const it2Seeded = await transferRow(db, p2.transferId);
  check("2.4 seeded: the transfer sits at 'received' with 4 units still inbound",
    it2Seeded.status === "received" && it2Seeded.received_at !== null,
    `${it2Seeded.status} / ${String(it2Seeded.received_at)}`);
  const preRecvC = await chinaLevel(db, fC.inventory_item_id);

  const recvC2 = await api("POST", `/admin/purchase-orders/${p2.poId}/receive`, {
    lines: [{ po_line_id: lineC.id, qty_received_now: 4 }],
  });
  check("2.5 the remaining 4 units were received on the PO",
    recvC2.status === 200, brief(recvC2));

  // THE assert the ['shipped']-only lookup kills: those 4 units physically left
  // China, and gating the lookup on 'shipped' makes the whole handler a no-op.
  await checkStock(db, "2.6 C left China although the transfer was already closed",
    fC.inventory_item_id, preRecvC.stocked - 4);
  await checkStock(db, "2.7 C total drawdown vs. the phase baseline",
    fC.inventory_item_id, baseC.stocked - 10);
  const endC = await chinaLevel(db, fC.inventory_item_id);
  check("2.8 C's remaining China reservation was released",
    endC.reserved === baseC.reserved && lockstep(endC),
    `${levelStr(baseC)} → ${levelStr(endC)}`);

  const it2Lines = await transferLines(db, p2.transferId);
  check("2.9 the IT line qty_received caught up (10 of 10)",
    it2Lines[0]?.qty_received === 10, JSON.stringify(it2Lines));

  const it2End = await transferRow(db, p2.transferId);
  check("2.10 the already-closed IT was NOT re-stamped (received_at preserved)",
    it2End.status === "received" && it2End.received_at === it2Seeded.received_at,
    `${it2End.status} / ${String(it2Seeded.received_at)} → ${String(it2End.received_at)}`);

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 3 — POSITIVE CONTROL: the ordinary open-transfer flow
  // ══════════════════════════════════════════════════════════════════════
  console.log("\nPhase 3 — positive control: partial receive → edit → receive the rest");

  const baseE = await chinaLevel(db, fE.inventory_item_id);
  const baseF = await chinaLevel(db, fF.inventory_item_id);

  const p3 = await createSubmitConvertShip(
    vendorRow.id,
    locRow.id,
    [poLine(fE, 10, 1200, 0)],
    "3.1"
  );

  const po3Lines = await poLines(p3.poId);
  const lineE = po3Lines.find((l) => l.product_variant_id === fE.variant_id);
  if (!lineE) throw new Error("PO3 line E not found");

  const recvE1 = await api("POST", `/admin/purchase-orders/${p3.poId}/receive`, {
    lines: [{ po_line_id: lineE.id, qty_received_now: 4 }],
  });
  check("3.2 partial receive (4 of 10)", recvE1.status === 200, brief(recvE1));

  const it3Partial = await transferRow(db, p3.transferId);
  check("3.3 the IT stays 'shipped' with received_at NULL",
    it3Partial.status === "shipped" && it3Partial.received_at === null,
    `${it3Partial.status} / ${String(it3Partial.received_at)}`);
  await checkStock(db, "3.4 E after the partial receive", fE.inventory_item_id,
    baseE.stocked - 4);
  const partialE = await chinaLevel(db, fE.inventory_item_id);
  check("3.5 E still reserves the 6 units in transit",
    partialE.reserved === baseE.reserved + 6 && lockstep(partialE),
    `${levelStr(baseE)} → ${levelStr(partialE)}`);

  // The trapdoor, exercised where it would actually do damage: a linked IT in
  // 'shipped' with units still inbound. Without the guard this route flips the
  // status to 'received' without moving a single unit out of China, and every
  // later PO receipt inherits a transfer it can no longer reopen.
  const itReceiveOpen = await api(
    "POST",
    `/admin/inventory-transfers/${p3.transferId}/receive`,
    {}
  );
  check("3.5b a SHIPPED linked transfer also refuses to be received directly",
    itReceiveOpen.status === 409 &&
      itReceiveOpen.body.code === "linked_po_receive_required",
    brief(itReceiveOpen));
  const it3AfterBlocked = await transferRow(db, p3.transferId);
  check("3.5c the refusal left the transfer 'shipped' (no phantom close)",
    it3AfterBlocked.status === "shipped" && it3AfterBlocked.received_at === null,
    `${it3AfterBlocked.status} / ${String(it3AfterBlocked.received_at)}`);

  const patch3 = await api("PATCH", `/admin/purchase-orders/${p3.poId}`, {
    lines: [
      ...patchPayload(po3Lines, (l) =>
        l.product_variant_id === fE.variant_id ? 12 : undefined
      ),
      poLine(fF, 3, 900, 9),
    ],
  });
  check("3.6 PO edited on an OPEN transfer (10→12 + new line F qty 3)",
    patch3.status === 200, brief(patch3));

  const po3Lines2 = await poLines(p3.poId);
  const lineE2 = po3Lines2.find((l) => l.product_variant_id === fE.variant_id);
  const lineF = po3Lines2.find((l) => l.product_variant_id === fF.variant_id);
  if (!lineE2 || !lineF) throw new Error("PO3 lines missing after the edit");

  const it3Lines = await transferLines(db, p3.transferId);
  const itE = it3Lines.find((l) => l.product_variant_id === fE.variant_id);
  const itF = it3Lines.find((l) => l.product_variant_id === fF.variant_id);
  check("3.7 the mirror still follows an OPEN transfer (E=12, F=3 present)",
    itE?.qty === 12 && itF?.qty === 3 && itF?.purchase_order_line_id === lineF.id,
    JSON.stringify(it3Lines));
  const it3AfterPatch = await transferRow(db, p3.transferId);
  check("3.8 header totals follow (2 lines / 15 units) and status is untouched",
    it3AfterPatch.total_lines === 2 &&
      it3AfterPatch.total_units === 15 &&
      it3AfterPatch.status === "shipped" &&
      it3AfterPatch.received_at === null,
    `${it3AfterPatch.status} lines=${it3AfterPatch.total_lines} units=${it3AfterPatch.total_units}`);

  const midE = await chinaLevel(db, fE.inventory_item_id);
  const midF = await chinaLevel(db, fF.inventory_item_id);
  check("3.9 reservations rebuilt for the outstanding units (E +8, F +3)",
    midE.reserved === baseE.reserved + 8 &&
      midF.reserved === baseF.reserved + 3 &&
      lockstep(midE) &&
      lockstep(midF),
    `E ${baseE.reserved}→${midE.reserved} · F ${baseF.reserved}→${midF.reserved}`);

  const recvRest = await api("POST", `/admin/purchase-orders/${p3.poId}/receive`, {
    lines: [
      { po_line_id: lineE2.id, qty_received_now: 8 },
      { po_line_id: lineF.id, qty_received_now: 3 },
    ],
  });
  check("3.10 the rest was received", recvRest.status === 200, brief(recvRest));

  await checkStock(db, "3.11 E fully drawn down", fE.inventory_item_id, baseE.stocked - 12);
  await checkStock(db, "3.12 F fully drawn down", fF.inventory_item_id, baseF.stocked - 3);
  const endE = await chinaLevel(db, fE.inventory_item_id);
  const endF = await chinaLevel(db, fF.inventory_item_id);
  check("3.13 every reservation released back to baseline",
    endE.reserved === baseE.reserved && endF.reserved === baseF.reserved,
    `E ${baseE.reserved}→${endE.reserved} · F ${baseF.reserved}→${endF.reserved}`);

  const it3End = await transferRow(db, p3.transferId);
  check("3.14 the IT closed ('received' + received_at)",
    it3End.status === "received" && it3End.received_at !== null,
    `${it3End.status} / ${String(it3End.received_at)}`);
  const it3EndLines = await transferLines(db, p3.transferId);
  check("3.15 IT line qty_received up to date (E=12, F=3)",
    it3EndLines.find((l) => l.product_variant_id === fE.variant_id)?.qty_received === 12 &&
      it3EndLines.find((l) => l.product_variant_id === fF.variant_id)?.qty_received === 3,
    JSON.stringify(it3EndLines));

  console.log(
    `\nPO1=${p1.poNumber ?? p1.poId} IT1=${p1.transferId}\n` +
      `PO2=${p2.poNumber ?? p2.poId} IT2=${p2.transferId}\n` +
      `PO3=${p3.poNumber ?? p3.poId} IT3=${p3.transferId}`
  );

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
