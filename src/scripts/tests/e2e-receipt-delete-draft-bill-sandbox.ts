/**
 * E2E — borrar un item receipt atado a un vendor bill DRAFT, con stock
 * insuficiente. SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * `verify-receipt-delete-draft-bill.ts` prueba el helper y el esquema, pero no
 * puede probar la RUTA: sus guards son SQL inline, y el camino real pasa por
 * el workflow entero (reversa de stock → unbind → borrado/lápida → QB).
 *
 * Reproduce el caso que motivó el cambio (RCP-1157 del PO-1110, 2026-08-04):
 * un receipt sincronizado a QuickBooks, atado a un bill DRAFT, con 20 unidades
 * recibidas y menos de 20 en el estante.
 *
 * ── Asimetría deliberada de las aserciones ────────────────────────────────────
 * Que el DELETE devuelva 200 no alcanza: un guard que se saltea de más también
 * da 200. Por eso cada caso afirma el EFECTO — que el bill draft siga vivo CON
 * sus líneas, que el stock haya quedado efectivamente negativo, y que el aviso
 * viaje en la respuesta. Y por eso existe el control negativo: si un bill
 * `confirmed` dejara de bloquear, todo lo demás seguiría en verde.
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox en :9099
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-receipt-delete-draft-bill-sandbox.ts
 *
 * Planta sus propios fixtures y los borra al final, pase o falle.
 */
import { randomUUID } from "crypto";

import { Client } from "pg";

// ── Guards fail-closed: el destino se EXIGE, no se infiere ───────────────────
const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`\n❌ ABORTADO: ${why}\n`);
  process.exit(2);
}

if (!/^http:\/\/(localhost|127\.0\.0\.1):9099(\/|$)/.test(BASE)) {
  abort(
    `BASE apunta a ${BASE}. Este script BORRA item receipts y deja stock ` +
      `negativo — sólo corre contra el backend sandbox en localhost:9099.`
  );
}
if (!/@(localhost|127\.0\.0\.1):5499\//.test(SB_DB)) {
  abort(
    `la DB no es la del sandbox (se esperaba localhost:5499). Este script ` +
      `borra filas y mueve inventario.`
  );
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
  opts: { token: string; method?: string; body?: Record<string, unknown> }
): Promise<Resp> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* no-JSON: queda `raw` para el diagnóstico */
  }
  return { status: res.status, body, raw };
}

interface Scenario {
  poId: string;
  poLineId: string;
  receiptId: string;
  receiptLineId: string;
  billId: string;
  billLineId: string;
  inventoryItemId: string;
  locationId: string;
}

/**
 * Planta PO → receipt (QB-synced) → vendor bill, con el stock del estante por
 * DEBAJO de lo recibido. Reproduce la forma de RCP-1157.
 */
async function plantScenario(
  db: Client,
  seq: number,
  billStatus: "draft" | "confirmed"
): Promise<Scenario> {
  const s: Scenario = {
    poId: randomUUID(),
    poLineId: randomUUID(),
    receiptId: randomUUID(),
    receiptLineId: randomUUID(),
    billId: randomUUID(),
    billLineId: randomUUID(),
    inventoryItemId: `iitem_e2e_${seq}_${randomUUID().slice(0, 8)}`,
    locationId: `sloc_e2e_${seq}_${randomUUID().slice(0, 8)}`,
  };

  // Inventario propio: 18 en el estante contra 20 recibidas, 1 reservada —
  // exactamente la posición que hacía fallar el edit y el delete.
  await db.query(
    `INSERT INTO inventory_item (id, sku, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())`,
    [s.inventoryItemId, `SKU-E2E-${seq}`]
  );
  await db.query(
    `INSERT INTO stock_location (id, name, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())`,
    [s.locationId, `E2E Location ${seq}`]
  );
  await db.query(
    `INSERT INTO inventory_level
       (id, inventory_item_id, location_id, stocked_quantity, reserved_quantity,
        incoming_quantity, raw_stocked_quantity, raw_reserved_quantity,
        raw_incoming_quantity, created_at, updated_at)
     VALUES ($1, $2, $3, 18, 1, 0,
             '{"value":"18","precision":20}'::jsonb,
             '{"value":"1","precision":20}'::jsonb,
             '{"value":"0","precision":20}'::jsonb, NOW(), NOW())`,
    [`ilev_e2e_${randomUUID().slice(0, 12)}`, s.inventoryItemId, s.locationId]
  );

  await db.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id,
                                 created_by_user_id, status, number, seq)
     VALUES ($1, 'vendor_e2e', $2, 'user_e2e', 'received', $3, $4)`,
    [s.poId, s.locationId, `PO-E2E-${seq}`, 990000 + seq]
  );
  await db.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qty_ordered, qty_received,
        unit_cost_cents, total_cents)
     VALUES ($1, $2, 'variant_e2e', $3, $4, 'E2E fixture line', 20, 20, 2610, 52200)`,
    [s.poLineId, s.poId, s.inventoryItemId, `SKU-E2E-${seq}`]
  );
  // qb_item_receipt_list_id poblado = "sincronizado a QB" (la detección NUNCA
  // es por receipt.status, que queda en 'applied').
  await db.query(
    `INSERT INTO purchase_order_receipt
       (id, purchase_order_id, number, seq, received_at, received_by_user_id,
        stock_location_id, status, qb_item_receipt_list_id)
     VALUES ($1, $2, $3, $4, NOW(), 'user_e2e', $5, 'applied', $6)`,
    [
      s.receiptId,
      s.poId,
      `RCP-E2E-${seq}`,
      990000 + seq,
      s.locationId,
      `E2E-TXN-${seq}`,
    ]
  );
  await db.query(
    `INSERT INTO purchase_order_receipt_line
       (id, purchase_order_receipt_id, purchase_order_line_id, purchase_order_id,
        product_variant_id, inventory_item_id, sku_snapshot, description_snapshot,
        qty_received_now, stock_applied)
     VALUES ($1, $2, $3, $4, 'variant_e2e', $5, $6, 'E2E fixture line', 20, true)`,
    [
      s.receiptLineId,
      s.receiptId,
      s.poLineId,
      s.poId,
      s.inventoryItemId,
      `SKU-E2E-${seq}`,
    ]
  );
  await db.query(
    `INSERT INTO qb_item_receipt_pipeline
       (id, purchase_order_receipt_id, purchase_order_id, status, qb_list_id,
        synced_at, payload)
     VALUES ($1, $2, $3, 'synced', $4, NOW(), '{}'::jsonb)`,
    [randomUUID(), s.receiptId, s.poId, `E2E-TXN-${seq}`]
  );
  await db.query(
    `INSERT INTO vendor_bill (id, purchase_order_id, purchase_order_receipt_id,
                              status, bill_type, number)
     VALUES ($1, $2, $3, $4, 'regular', $5)`,
    [s.billId, s.poId, s.receiptId, billStatus, `VB-E2E-${seq}`]
  );
  await db.query(
    `UPDATE purchase_order_receipt SET vendor_bill_id = $1 WHERE id = $2`,
    [s.billId, s.receiptId]
  );
  await db.query(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, sku, description, qty, unit_cost_cents,
        purchase_order_line_id, receipt_line_id)
     VALUES ($1, $2, $3, 'E2E fixture line', 20, 2610, $4, $5)`,
    [s.billLineId, s.billId, `SKU-E2E-${seq}`, s.poLineId, s.receiptLineId]
  );

  return s;
}

async function cleanup(db: Client, scenarios: Scenario[]): Promise<void> {
  for (const s of scenarios) {
    await db.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [s.billId]);
    await db.query(`DELETE FROM vendor_bill WHERE id = $1`, [s.billId]);
    await db.query(
      `DELETE FROM qb_item_receipt_pipeline WHERE purchase_order_receipt_id = $1`,
      [s.receiptId]
    );
    await db.query(`DELETE FROM purchase_order_receipt WHERE id = $1`, [s.receiptId]);
    await db.query(`DELETE FROM purchase_order_line WHERE purchase_order_id = $1`, [s.poId]);
    await db.query(`DELETE FROM purchase_order WHERE id = $1`, [s.poId]);
    await db.query(`DELETE FROM inventory_level WHERE inventory_item_id = $1`, [
      s.inventoryItemId,
    ]);
    await db.query(`DELETE FROM inventory_item WHERE id = $1`, [s.inventoryItemId]);
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

async function main(): Promise<void> {
  console.log("=== e2e-receipt-delete-draft-bill (sandbox) ===\n");

  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const auth = (await authRes.json()) as { token?: string };
  if (!auth.token) {
    await db.end();
    abort(`login falló (${authRes.status}). ¿Está ./back-sb arriba?`);
  }
  const token = auth.token;

  const planted: Scenario[] = [];
  try {
    // ── CASO 1 — bill DRAFT: el delete procede ───────────────────────────────
    console.log("CASO 1 — receipt QB-synced atado a un bill DRAFT, stock 18 < 20");
    const draft = await plantScenario(db, 1, "draft");
    planted.push(draft);
    check("el fixture arranca con 18 en el estante", (await stockOf(db, draft)) === 18);

    const del = await call(
      `/admin/purchase-orders/${draft.poId}/receipts/${draft.receiptId}`,
      { token, method: "DELETE", body: { delete_reason: "e2e" } }
    );
    check(
      "DELETE devuelve 200 (un bill draft ya no bloquea)",
      del.status === 200,
      `status=${del.status} body=${del.raw.slice(0, 300)}`
    );

    const warnings = (del.body.warnings ?? []) as Array<Record<string, unknown>>;
    check(
      "la respuesta trae el aviso de stock — el único resguardo que queda",
      warnings.length === 1 && warnings[0]?.code === "stock_goes_negative",
      `warnings=${JSON.stringify(warnings)}`
    );
    check(
      "el aviso nombra el SKU y la posición resultante",
      typeof warnings[0]?.message === "string" &&
        (warnings[0].message as string).includes("SKU-E2E-1") &&
        (warnings[0].message as string).includes("-2"),
      String(warnings[0]?.message)
    );

    // EL EFECTO, no el código de estado.
    check(
      "el stock quedó REALMENTE en -2 (negativo permitido, no clampeado a 0)",
      (await stockOf(db, draft)) === -2,
      `stock=${await stockOf(db, draft)}`
    );

    const { rows: billRows } = await db.query<{ n: string; status: string }>(
      `SELECT number AS n, status FROM vendor_bill WHERE id = $1`,
      [draft.billId]
    );
    check(
      "EL BILL DRAFT SIGUE VIVO — el CASCADE no se lo llevó",
      billRows.length === 1,
      "el vendor bill fue destruido por la FK ON DELETE CASCADE"
    );
    const { rows: billLineRows } = await db.query(
      `SELECT 1 FROM vendor_bill_line WHERE id = $1`,
      [draft.billLineId]
    );
    check(
      "y conserva sus líneas, así que su drift tiene qué reportar",
      billLineRows.length === 1
    );
    const { rows: unbound } = await db.query<{ p: string | null }>(
      `SELECT purchase_order_receipt_id AS p FROM vendor_bill WHERE id = $1`,
      [draft.billId]
    );
    check(
      "el bill quedó desatado del receipt (puntero primario en NULL)",
      unbound[0]?.p === null,
      `puntero=${unbound[0]?.p}`
    );

    const { rows: tomb } = await db.query<{ status: string }>(
      `SELECT status FROM purchase_order_receipt WHERE id = $1`,
      [draft.receiptId]
    );
    check(
      "el receipt QB-synced quedó como lápida 'deleted' (Path B, el poller cierra en QB)",
      tomb[0]?.status === "deleted",
      `status=${tomb[0]?.status ?? "fila ausente"}`
    );
    const { rows: voidQueued } = await db.query<{ v: string | null }>(
      `SELECT void_status AS v FROM qb_item_receipt_pipeline
        WHERE purchase_order_receipt_id = $1`,
      [draft.receiptId]
    );
    check(
      "el borrado en QuickBooks quedó encolado",
      voidQueued[0]?.v === "waiting",
      `void_status=${voidQueued[0]?.v}`
    );

    // ── CASO 2 — CONTROL NEGATIVO: bill CONFIRMED sigue bloqueando ───────────
    console.log(
      "\nCASO 2 — control negativo: el mismo escenario con el bill CONFIRMED"
    );
    const confirmed = await plantScenario(db, 2, "confirmed");
    planted.push(confirmed);

    const blocked = await call(
      `/admin/purchase-orders/${confirmed.poId}/receipts/${confirmed.receiptId}`,
      { token, method: "DELETE", body: { delete_reason: "e2e" } }
    );
    check(
      "DELETE devuelve 409 — un bill posteado SIGUE bloqueando",
      blocked.status === 409,
      `status=${blocked.status} body=${blocked.raw.slice(0, 300)}`
    );
    check(
      "y con el código que nombra la causa",
      blocked.body.code === "receipt_has_active_vendor_bill",
      `code=${String(blocked.body.code)}`
    );
    check(
      "el mensaje nombra el bill que hay que resolver",
      typeof blocked.body.error === "string" &&
        (blocked.body.error as string).includes("VB-E2E-2"),
      String(blocked.body.error)
    );
    check(
      "el stock NO se movió: un delete rechazado no toca inventario",
      (await stockOf(db, confirmed)) === 18,
      `stock=${await stockOf(db, confirmed)}`
    );
    const { rows: stillThere } = await db.query<{ status: string }>(
      `SELECT status FROM purchase_order_receipt WHERE id = $1`,
      [confirmed.receiptId]
    );
    check(
      "y el receipt sigue 'applied'",
      stillThere[0]?.status === "applied",
      `status=${stillThere[0]?.status}`
    );

    // ── CASO 3 — reducir cantidades ya no topa contra el piso de stock ───────
    // 20 → 2 sobre un estante de 18 deja el stock en 0, DEBAJO de la unidad
    // reservada pero sin llegar a negativo: es el caso que aísla el segundo
    // guard. (Un 20 → 5 deja 3, que está POR ENCIMA de la reserva y por lo
    // tanto no debe avisar nada — la primera versión de este test lo pedía
    // igual y falló con razón.)
    console.log(
      "\nCASO 3 — bajar la cantidad de 20 a 2 con sólo 18 en el estante y 1 reservada"
    );
    const edit = await plantScenario(db, 3, "draft");
    planted.push(edit);
    const patch = await call(
      `/admin/purchase-orders/${edit.poId}/receipts/${edit.receiptId}`,
      {
        token,
        method: "PATCH",
        body: {
          line_qty_changes: [
            { receipt_line_id: edit.receiptLineId, new_qty: 2 },
          ],
        },
      }
    );
    check(
      "PATCH devuelve 200 (el piso de reserved ya no bloquea)",
      patch.status === 200,
      `status=${patch.status} body=${patch.raw.slice(0, 300)}`
    );
    const editWarnings = (patch.body.warnings ?? []) as Array<
      Record<string, unknown>
    >;
    check(
      "y avisa que quedó por debajo de lo reservado",
      editWarnings.length === 1 &&
        editWarnings[0]?.code === "stock_below_reserved",
      `warnings=${JSON.stringify(editWarnings)}`
    );
    check(
      "el stock bajó a 0 (18 − 18), por debajo de la 1 unidad reservada",
      (await stockOf(db, edit)) === 0,
      `stock=${await stockOf(db, edit)}`
    );
    const { rows: qtyRows } = await db.query<{ q: number }>(
      `SELECT qty_received_now AS q FROM purchase_order_receipt_line WHERE id = $1`,
      [edit.receiptLineId]
    );
    check(
      "y la cantidad del receipt quedó en 2",
      Number(qtyRows[0]?.q) === 2,
      `qty=${qtyRows[0]?.q}`
    );
  } finally {
    await cleanup(db, planted);
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length} passed, ${failed.length} failed\n`
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
