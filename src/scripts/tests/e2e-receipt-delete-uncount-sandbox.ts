/**
 * E2E — borrar un item receipt SIN stock aplicado (forma del backfill de QB)
 * libera la línea del PO y permite borrarla. SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * PO-0099 (2026-09-15): los 481 recibos importados de QB vienen con
 * `stock_applied=false`. El DELETE de recibo descontaba `qty_received` de la
 * línea del PO sólo por las líneas con stock aplicado → para un recibo del
 * backfill no descontaba NADA, y la línea quedaba "recibida" por un recibo
 * muerto. Encima, un recibo QB-synced dejaba su LÍNEA-lápida viva, con FK
 * ON DELETE RESTRICT contra la línea del PO: borrar la línea era imposible
 * por dos caminos a la vez (guard 409 + FK).
 *
 * ── Asimetría deliberada de las aserciones ────────────────────────────────────
 * El 200 del DELETE no alcanza. Cada caso afirma el EFECTO sobre la base:
 *   A (backfill)  — qty_received 20→0 y status open; stock INTACTO (nunca se
 *                   aplicó, no hay nada que reversar); líneas-lápida borradas;
 *                   header tombstone; y el PATCH que saca la línea da 200.
 *   B (control +) — recibo con stock aplicado: qty_received 20→0 Y stock 20→0.
 *                   Si A pasara porque el filtro se relajó de más, B lo delata
 *                   (el stock se movería en A o no se movería en B).
 *   C (control −) — línea con recibo VIVO: el PATCH que la saca sigue en 409.
 *                   Sin esto, un guard que dejó de morder daría todo verde.
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox
 *   SANDBOX_BASE_URL=http://localhost:9098 \
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-receipt-delete-uncount-sandbox.ts
 */
import { randomUUID } from "crypto";

import { Client } from "pg";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}

if (!/^http:\/\/(localhost|127\.0\.0\.1):909\d(\/|$)/.test(BASE)) {
  abort(
    `BASE apunta a ${BASE}. Este script BORRA recibos y líneas de PO — sólo sandbox.`
  );
}
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  abort(`la DB no es la del sandbox (se esperaba localhost:5499).`);
}

interface Result {
  ok: boolean;
  name: string;
  detail: string;
}
const results: Result[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  results.push({ ok, name, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}

interface Resp {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

async function call(
  path: string,
  opts: {
    token: string;
    pin?: string;
    method?: string;
    body?: Record<string, unknown>;
  }
): Promise<Resp> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  };
  if (opts.pin !== undefined) headers["x-supervisor-pin"] = opts.pin;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* no-JSON: queda `raw` */
  }
  return { status: res.status, body, raw };
}

interface Scenario {
  seq: number;
  poId: string;
  poLineId: string;
  keepLineId: string;
  receiptId: string;
  receiptLineId: string;
  inventoryItemId: string;
  keepInventoryItemId: string;
  locationId: string;
}

/**
 * PO de 2 líneas (la 2ª nunca se recibe y sobrevive al PATCH), un recibo
 * QB-synced de 20 unidades sobre la 1ª. `stockApplied` decide la forma:
 * false = recibo del backfill (stock en el estante independiente: 18).
 */
async function plantScenario(
  db: Client,
  seq: number,
  stockApplied: boolean
): Promise<Scenario> {
  const s: Scenario = {
    seq,
    poId: randomUUID(),
    poLineId: randomUUID(),
    keepLineId: randomUUID(),
    receiptId: randomUUID(),
    receiptLineId: randomUUID(),
    inventoryItemId: `iitem_e2e_${seq}_${randomUUID().slice(0, 8)}`,
    keepInventoryItemId: `iitem_e2e_${seq}k_${randomUUID().slice(0, 8)}`,
    locationId: `sloc_e2e_${seq}_${randomUUID().slice(0, 8)}`,
  };

  for (const [iid, sku] of [
    [s.inventoryItemId, `SKU-E2E-${seq}`],
    [s.keepInventoryItemId, `SKU-E2E-${seq}-KEEP`],
  ]) {
    await db.query(
      `INSERT INTO inventory_item (id, sku, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())`,
      [iid, sku]
    );
  }
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at) VALUES ($1, $2, NOW(), NOW())`,
    [s.locationId, `E2E Location ${seq}`]
  );
  // Stock aplicado: el estante refleja las 20 recibidas. Backfill: 18, un
  // número que NO coincide con lo recibido, para que un decremento indebido
  // (18→-2) o uno que falte (20→20) se vean sin ambigüedad.
  const shelf = stockApplied ? 20 : 18;
  await db.query(
    `INSERT INTO inventory_level
       (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity,
        incoming_quantity, raw_stocked_quantity, raw_reserved_quantity,
        raw_incoming_quantity, created_at, updated_at)
     VALUES ($1, $2, $3, $4::int, 0, 0,
             jsonb_build_object('value', $5::text, 'precision', 20),
             '{"value":"0","precision":20}'::jsonb,
             '{"value":"0","precision":20}'::jsonb, NOW(), NOW())`,
    [
      `ilev_e2e_${randomUUID().slice(0, 12)}`,
      s.inventoryItemId,
      s.locationId,
      shelf,
      String(shelf),
    ]
  );

  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id, created_by_user_id,
                                 status, number, seq, total_lines, total_units_ordered,
                                 total_units_received)
     VALUES ($1, 'vendor_e2e', $2, 'user_e2e', 'partially_received', $3, $4, 2, 25, 20)`,
    [s.poId, s.locationId, `PO-E2E-${seq}`, 980000 + seq]
  );
  await db.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id, sku_snapshot,
        description_snapshot, qty_ordered, qty_received, unit_cost_cents, total_cents,
        status, line_order)
     VALUES ($1, $2, 'variant_e2e', $3, $4, 'E2E received line', 20, 20, 2610, 52200, 'complete', 0),
            ($5, $2, 'variant_e2e_keep', $6, $7, 'E2E untouched line', 5, 0, 100, 500, 'open', 1)`,
    [
      s.poLineId,
      s.poId,
      s.inventoryItemId,
      `SKU-E2E-${seq}`,
      s.keepLineId,
      s.keepInventoryItemId,
      `SKU-E2E-${seq}-KEEP`,
    ]
  );
  await db.query(
    `INSERT INTO purchase_order_receipt
       (id, purchase_order_id, number, seq, received_at, received_by_user_id,
        stock_location_id, status, qb_item_receipt_list_id)
     VALUES ($1, $2, $3, $4, NOW(), $5, $6, 'applied', $7)`,
    [
      s.receiptId,
      s.poId,
      `RCP-E2E-${seq}`,
      980000 + seq,
      stockApplied ? "user_e2e" : "qb-backfill-system",
      s.locationId,
      `E2E-TXN-${seq}`,
    ]
  );
  await db.query(
    `INSERT INTO purchase_order_receipt_line
       (id, purchase_order_receipt_id, purchase_order_line_id, purchase_order_id,
        product_variant_id, inventory_item_id, sku_snapshot, description_snapshot,
        qty_received_now, stock_applied, stock_applied_at)
     VALUES ($1, $2, $3, $4, 'variant_e2e', $5, $6, 'E2E received line', 20, $7::boolean,
             CASE WHEN $7::boolean THEN NOW() ELSE NULL END)`,
    [
      s.receiptLineId,
      s.receiptId,
      s.poLineId,
      s.poId,
      s.inventoryItemId,
      `SKU-E2E-${seq}`,
      stockApplied,
    ]
  );
  await db.query(
    `INSERT INTO qb_item_receipt_pipeline
       (id, purchase_order_receipt_id, purchase_order_id, status, qb_list_id, synced_at, payload)
     VALUES ($1, $2, $3, 'synced', $4, NOW(), '{}'::jsonb)`,
    [randomUUID(), s.receiptId, s.poId, `E2E-TXN-${seq}`]
  );
  return s;
}

async function cleanup(db: Client, scenarios: Scenario[]): Promise<void> {
  for (const s of scenarios) {
    await db.query(
      `DELETE FROM qb_purchase_order_pipeline WHERE purchase_order_id = $1`,
      [s.poId]
    );
    await db.query(
      `DELETE FROM qb_item_receipt_pipeline WHERE purchase_order_id = $1`,
      [s.poId]
    );
    await db.query(
      `DELETE FROM purchase_order_receipt_line WHERE purchase_order_id = $1`,
      [s.poId]
    );
    await db.query(
      `DELETE FROM purchase_order_receipt WHERE purchase_order_id = $1`,
      [s.poId]
    );
    await db.query(
      `DELETE FROM purchase_order_line WHERE purchase_order_id = $1`,
      [s.poId]
    );
    await db.query(`DELETE FROM purchase_order WHERE id = $1`, [s.poId]);
    await db.query(
      `DELETE FROM inventory_level WHERE inventory_item_id IN ($1, $2)`,
      [s.inventoryItemId, s.keepInventoryItemId]
    );
    await db.query(`DELETE FROM inventory_item WHERE id IN ($1, $2)`, [
      s.inventoryItemId,
      s.keepInventoryItemId,
    ]);
    await db.query(`DELETE FROM stock_location WHERE id = $1`, [s.locationId]);
  }
}

async function stockOf(db: Client, s: Scenario): Promise<number> {
  const { rows } = await db.query<{ q: string }>(
    `SELECT stocked_quantity::text AS q FROM inventory_level
      WHERE inventory_item_id = $1 AND location_id = $2`,
    [s.inventoryItemId, s.locationId]
  );
  return Number(rows[0]?.q ?? "NaN");
}

async function poLine(
  db: Client,
  id: string
): Promise<{ qty_received: number; status: string } | null> {
  const { rows } = await db.query<{ qty_received: number; status: string }>(
    `SELECT qty_received::int AS qty_received, status FROM purchase_order_line
      WHERE id = $1 AND deleted_at IS NULL`,
    [id]
  );
  return rows[0] ?? null;
}

async function receiptState(
  db: Client,
  s: Scenario
): Promise<{ status: string | null; lines: number }> {
  const { rows } = await db.query<{ status: string | null; lines: string }>(
    `SELECT r.status, (SELECT count(*) FROM purchase_order_receipt_line rl
                        WHERE rl.purchase_order_receipt_id = r.id) AS lines
       FROM purchase_order_receipt r WHERE r.id = $1`,
    [s.receiptId]
  );
  return rows[0]
    ? { status: rows[0].status, lines: Number(rows[0].lines) }
    : { status: null, lines: 0 };
}

/** PATCH que conserva sólo la 2ª línea = pide borrar la 1ª. */
function patchDroppingReceivedLine(s: Scenario): Record<string, unknown> {
  return {
    lines: [
      {
        id: s.keepLineId,
        product_variant_id: "variant_e2e_keep",
        inventory_item_id: s.keepInventoryItemId,
        sku_snapshot: `SKU-E2E-${s.seq}-KEEP`,
        description_snapshot: "E2E untouched line",
        qty_ordered: 5,
        unit_cost_cents: 100,
        line_order: 0,
      },
    ],
  };
}

async function main(): Promise<void> {
  console.log("=== e2e-receipt-delete-uncount (sandbox) ===\n");

  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const token = ((await authRes.json()) as { token?: string }).token;
  if (!token)
    abort(
      `login falló (${authRes.status}) — ¿backend sandbox arriba en ${BASE}?`
    );

  const { rows: pinRows } = await db.query<{ pin: string }>(
    `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store
      WHERE metadata->>'pos_supervisor_pin' IS NOT NULL ORDER BY id LIMIT 1`
  );
  const pin = pinRows[0]?.pin;
  if (!pin)
    abort(
      "el store del sandbox no tiene pos_supervisor_pin (el PATCH de un PO no-draft lo exige)."
    );

  const seq = Math.floor(Date.now() / 1000) % 100000;
  const scenarios: Scenario[] = [];
  let exitCode = 0;

  try {
    // ── A: recibo del backfill (stock_applied=false) ─────────────────────────
    console.log("A) recibo QB-backfill (sin stock aplicado)");
    const A = await plantScenario(db, seq, false);
    scenarios.push(A);

    const delA = await call(
      `/admin/purchase-orders/${A.poId}/receipts/${A.receiptId}`,
      {
        token,
        method: "DELETE",
        body: { delete_reason: "e2e uncount" },
      }
    );
    check(
      "DELETE recibo → 200",
      delA.status === 200,
      `${delA.status} ${delA.raw.slice(0, 200)}`
    );

    const lineA = await poLine(db, A.poLineId);
    check(
      "línea del PO vuelve a qty_received=0 / open",
      lineA?.qty_received === 0 && lineA?.status === "open",
      JSON.stringify(lineA)
    );
    const stockA = await stockOf(db, A);
    check(
      "stock INTACTO (18 → 18): nada que reversar",
      stockA === 18,
      `stock=${stockA}`
    );
    const rsA = await receiptState(db, A);
    check(
      "recibo queda como lápida (status=deleted) SIN líneas",
      rsA.status === "deleted" && rsA.lines === 0,
      JSON.stringify(rsA)
    );
    const { rows: hdrA } = await db.query<{
      status: string;
      total_units_received: number;
    }>(
      `SELECT status, total_units_received::int AS total_units_received FROM purchase_order WHERE id = $1`,
      [A.poId]
    );
    check(
      "header del PO: 0 recibidas → submitted",
      hdrA[0]?.total_units_received === 0 && hdrA[0]?.status === "submitted", // entity-status
      JSON.stringify(hdrA[0])
    );

    const patchA = await call(`/admin/purchase-orders/${A.poId}`, {
      token,
      pin,
      method: "PATCH",
      body: patchDroppingReceivedLine(A),
    });
    check(
      "PATCH que saca la línea → 200",
      patchA.status === 200,
      `${patchA.status} ${patchA.raw.slice(0, 300)}`
    );
    check("la línea ya no existe", (await poLine(db, A.poLineId)) === null);
    check("la otra línea sobrevive", (await poLine(db, A.keepLineId)) !== null);

    // ── B: control positivo — recibo con stock aplicado ──────────────────────
    console.log("\nB) control: recibo normal (stock aplicado)");
    const B = await plantScenario(db, seq + 1, true);
    scenarios.push(B);
    const delB = await call(
      `/admin/purchase-orders/${B.poId}/receipts/${B.receiptId}`,
      {
        token,
        method: "DELETE",
        body: { delete_reason: "e2e control" },
      }
    );
    check(
      "DELETE recibo → 200",
      delB.status === 200,
      `${delB.status} ${delB.raw.slice(0, 200)}`
    );
    const lineB = await poLine(db, B.poLineId);
    check(
      "qty_received 20 → 0",
      lineB?.qty_received === 0,
      JSON.stringify(lineB)
    );
    const stockB = await stockOf(db, B);
    check("stock SÍ se reversa (20 → 0)", stockB === 0, `stock=${stockB}`);
    const rsB = await receiptState(db, B);
    check(
      "lápida sin líneas también acá",
      rsB.status === "deleted" && rsB.lines === 0,
      JSON.stringify(rsB)
    );

    // ── C: control negativo — recibo VIVO sigue bloqueando ───────────────────
    console.log("\nC) control negativo: la línea con recibo vivo NO se borra");
    const C = await plantScenario(db, seq + 2, true);
    scenarios.push(C);
    const patchC = await call(`/admin/purchase-orders/${C.poId}`, {
      token,
      pin,
      method: "PATCH",
      body: patchDroppingReceivedLine(C),
    });
    check(
      "PATCH → 409 nombrando las unidades recibidas",
      patchC.status === 409 && /received/i.test(patchC.raw),
      `${patchC.status} ${patchC.raw.slice(0, 300)}`
    );
    check(
      "la línea sigue ahí, 20 recibidas",
      (await poLine(db, C.poLineId))?.qty_received === 20
    );
  } catch (err) {
    console.error("\n💥 excepción:", err);
    exitCode = 1;
  } finally {
    await cleanup(db, scenarios);
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks OK`
  );
  if (failed.length > 0 || exitCode !== 0) {
    console.log("FAIL");
    process.exit(1);
  }
  console.log("PASS");
}

void main();
