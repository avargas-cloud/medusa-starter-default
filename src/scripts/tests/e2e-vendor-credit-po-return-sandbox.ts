/**
 * e2e-vendor-credit-po-return-sandbox.ts — E2E del vendor credit atado a un
 * PO (plan `vc-po-return-20260911`) contra el SANDBOX `medusa_gl`, por las
 * RUTAS HTTP reales (no por la librería): es la única forma de ejercitar el
 * movimiento de stock, que corre como workflow de Medusa desde la ruta.
 *
 * Fixture directo-DB (reusa `e2e-gl-purchases-fixtures.ts`: PO con 10
 * recibidas a $10.00, receipt applied, bill regular confirmado a $12.00/u)
 * sobre un variant/inventory_item REAL del sandbox, así el `inventory_level`
 * existe y el stock se mide antes/después.
 *
 * Flujo y asserts:
 *   1. otro draft reclama 4 → crear con 7 → 400 exceeds_returnable (10−4=6)
 *   2. producto sin PO → 400 product_line_requires_po · lines:[] → 400 no_lines
 *   3. crear con PO + bill, 3 u @ $12 → 201; GET trae po_number, vendor_bill_number, purchase_order_line_id
 *   4. po-returnable?exclude_credit_id → credited 4, returnable 6, unit_cost 1200 (bill), bills ∋ fixture
 *   5. PATCH qty 7 → exceeds_returnable · PATCH lines:[] → no_lines · PATCH bill ajeno → bill_not_on_po
 *   6. post → stock −3 en la location del PO, stock_applied_at, GL AP debitada $36.00
 *   7. race gate: draft C (3 u) mutado por SQL a 6 → post → 400 exceeds_returnable
 *   8. DELETE draft C y del otro draft → 200; returnable = 7; DELETE de un posted → 409
 *   9. void → stock restaurado, stock_reversed_at, sin entrada GL activa
 *
 * Requiere el backend del sandbox levantado con `POS_OWNER_EMAILS` incluyendo
 * al usuario de prueba (requireFullAdmin = Accounting). Aborta si
 * `DATABASE_URL` no apunta a `/medusa_gl`.
 *
 * Correr:
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_gl' \
 *   E2E_BASE_URL=http://localhost:9097 E2E_EMAIL=sandbox@test.com E2E_PASSWORD=sandbox123 \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-vendor-credit-po-return-sandbox.ts
 */
import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { activeDocumentEntry } from "../../lib/ledger";
import { createDraftVendorCredit } from "../../lib/vendor-credits";

import { buildFixture, cleanup, type Fixture } from "./e2e-gl-purchases-fixtures";

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const ok = (name: string, cond: boolean, detail?: string) => checks.push({ name, ok: cond, detail });

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:9097";
const EMAIL = process.env.E2E_EMAIL ?? "sandbox@test.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "sandbox123";
const FX = `e2evc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
const today = new Date().toISOString().slice(0, 10);

type Json = Record<string, unknown>;
let token = "";

async function http(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? (JSON.parse(text) as Json) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function login(): Promise<void> {
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const json = (await res.json()) as { token?: string };
  if (!res.ok || !json.token) throw new Error(`login failed (${res.status}): ${JSON.stringify(json)}`);
  token = json.token;
}

async function stockAt(client: PoolClient, inventoryItemId: string, locationId: string): Promise<number> {
  const { rows } = await client.query<{ q: string }>(
    `SELECT stocked_quantity::text AS q FROM inventory_level
      WHERE inventory_item_id = $1 AND location_id = $2 AND deleted_at IS NULL`,
    [inventoryItemId, locationId]
  );
  return Number(rows[0]?.q ?? 0);
}

async function fixtureRefs(client: PoolClient, fx: Fixture): Promise<{ inventory_item_id: string; location_id: string }> {
  const { rows } = await client.query<{ inventory_item_id: string; location_id: string }>(
    `SELECT pol.inventory_item_id, po.stock_location_id AS location_id
       FROM purchase_order_line pol JOIN purchase_order po ON po.id = pol.purchase_order_id
      WHERE pol.id = $1`,
    [fx.polId]
  );
  return rows[0]!;
}

const productLine = (polId: string, qty: number, cents = 1200) => ({
  line_type: "product",
  purchase_order_line_id: polId,
  qty,
  unit_cost_cents: cents,
  amount_cents: qty * cents,
});

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !url.includes("/medusa_gl")) {
    console.error(`e2e-vendor-credit-po-return: DATABASE_URL debe apuntar a /medusa_gl. Valor actual: ${url ?? "(vacío)"}`);
    process.exit(1);
    return;
  }
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  let fx: Fixture | null = null;
  const createdCreditIds: string[] = [];
  let stockBefore = 0;
  let refs: { inventory_item_id: string; location_id: string } | null = null;
  try {
    await login();
    await client.query("BEGIN");
    fx = await buildFixture(client, FX);
    await client.query("COMMIT");
    refs = await fixtureRefs(client, fx);
    stockBefore = await stockAt(client, refs.inventory_item_id, refs.location_id);

    // 1. otro draft (directo-DB) reclama 4 de las 10 recibidas
    const other = await createDraftVendorCredit(client, {
      vendor_id: fx.vendor_id,
      credit_date: today,
      purchase_order_id: fx.poId,
      lines: [productLine(fx.polId, 4)],
      actor_id: "e2e",
    });
    createdCreditIds.push(other.id);

    const tooMany = await http("POST", "/admin/vendor-credits", {
      vendor_id: fx.vendor_id,
      credit_date: today,
      purchase_order_id: fx.poId,
      lines: [productLine(fx.polId, 7)],
    });
    ok("1. crear 7 con 4 ya reclamadas y 10 recibidas → 400 exceeds_returnable", tooMany.status === 400 && tooMany.json.code === "exceeds_returnable", JSON.stringify(tooMany.json));

    // 2. producto sin PO · sin líneas
    const noPo = await http("POST", "/admin/vendor-credits", {
      vendor_id: fx.vendor_id,
      credit_date: today,
      lines: [{ line_type: "product", variant_id: fx.product_variant_id, qty: 1, unit_cost_cents: 100, amount_cents: 100 }],
    });
    ok("2a. producto sin PO → 400 product_line_requires_po", noPo.status === 400 && noPo.json.code === "product_line_requires_po", JSON.stringify(noPo.json));
    const noLines = await http("POST", "/admin/vendor-credits", { vendor_id: fx.vendor_id, credit_date: today, purchase_order_id: fx.poId, lines: [] });
    ok("2b. lines:[] → 400 no_lines", noLines.status === 400 && noLines.json.code === "no_lines", JSON.stringify(noLines.json));

    // 3. crear el crédito real: 3 u @ $12, atado al bill del fixture
    const created = await http("POST", "/admin/vendor-credits", {
      vendor_id: fx.vendor_id,
      credit_date: today,
      reason: "E2E return",
      purchase_order_id: fx.poId,
      vendor_bill_id: fx.billId,
      lines: [productLine(fx.polId, 3)],
    });
    const creditId = (created.json.vendor_credit as { id?: string } | undefined)?.id ?? "";
    ok("3a. crear con PO + bill → 201 con VC-####", created.status === 201 && !!creditId && /^VC-\d+$/.test(String((created.json.vendor_credit as Json).number)), JSON.stringify(created.json));
    if (creditId) createdCreditIds.push(creditId);
    const detail = await http("GET", `/admin/vendor-credits/${creditId}`);
    const vc = detail.json.vendor_credit as Json;
    const lines = detail.json.lines as Json[];
    ok(
      "3b. GET trae po_number, vendor_bill_number y purchase_order_line_id",
      vc.purchase_order_id === fx.poId && vc.po_number === `E2E-${FX}` && vc.vendor_bill_id === fx.billId && vc.vendor_bill_number === `VB-${FX}` && lines[0]?.purchase_order_line_id === fx.polId,
      JSON.stringify({ po: vc.po_number, bill: vc.vendor_bill_number, pol: lines[0]?.purchase_order_line_id })
    );

    // 4. po-returnable excluyendo este crédito
    const ret = await http("GET", `/admin/vendor-credits/po-returnable/${fx.poId}?exclude_credit_id=${creditId}`);
    const retLine = (ret.json.lines as Json[]).find((l) => l.purchase_order_line_id === fx.polId);
    const retBills = ret.json.bills as Json[];
    ok(
      "4. po-returnable: credited 4 (otro draft), returnable 6, unit_cost 1200 del bill, bills ∋ fixture",
      ret.status === 200 && retLine?.qty_received === 10 && retLine?.qty_credited === 4 && retLine?.qty_returnable === 6 && Number(retLine?.unit_cost_cents) === 1200 && Number(retLine?.bill_unit_cost_cents) === 1200 && retBills.some((b) => b.id === fx!.billId),
      JSON.stringify({ line: retLine, bills: retBills.map((b) => b.id) })
    );

    // 5. PATCH inválidos
    const p1 = await http("PATCH", `/admin/vendor-credits/${creditId}`, { lines: [productLine(fx.polId, 7)] });
    ok("5a. PATCH qty 7 → 400 exceeds_returnable", p1.status === 400 && p1.json.code === "exceeds_returnable", JSON.stringify(p1.json));
    const p2 = await http("PATCH", `/admin/vendor-credits/${creditId}`, { lines: [] });
    ok("5b. PATCH lines:[] → 400 no_lines", p2.status === 400 && p2.json.code === "no_lines", JSON.stringify(p2.json));
    const p3 = await http("PATCH", `/admin/vendor-credits/${creditId}`, { vendor_bill_id: "vb_not_on_this_po" });
    ok("5c. PATCH bill ajeno → 400 bill_not_on_po", p3.status === 400 && p3.json.code === "bill_not_on_po", JSON.stringify(p3.json));
    const p4 = await http("PATCH", `/admin/vendor-credits/${creditId}`, { vendor_bill_id: null });
    const p5 = await http("PATCH", `/admin/vendor-credits/${creditId}`, { vendor_bill_id: fx.billId });
    ok("5d. PATCH bill null y de vuelta al del PO → 200/200", p4.status === 200 && p5.status === 200, `${p4.status}/${p5.status}`);

    // 6. post → stock −3, marca, GL
    const posted = await http("POST", `/admin/vendor-credits/${creditId}/post`);
    const stock = posted.json.stock as Json;
    const stockAfterPost = await stockAt(client, refs.inventory_item_id, refs.location_id);
    ok("6a. post → 200 y stock.moved con 1 línea ajustada", posted.status === 200 && stock?.moved === true && stock?.adjusted === 1, JSON.stringify(posted.json));
    ok("6b. stock en la location del PO bajó exactamente 3", stockAfterPost === stockBefore - 3, `before=${stockBefore} after=${stockAfterPost}`);
    const { rows: marks } = await client.query<{ a: string | null; r: string | null; status: string }>(
      `SELECT stock_applied_at::text AS a, stock_reversed_at::text AS r, status FROM vendor_credit WHERE id = $1`,
      [creditId]
    );
    ok("6c. stock_applied_at seteado, stock_reversed_at NULL, status posted", !!marks[0]?.a && marks[0]?.r === null && marks[0]?.status === "posted", JSON.stringify(marks[0]));
    const glEntry = await activeDocumentEntry(client, "vendor_credit", creditId);
    ok("6d. GL: entrada activa del crédito por $36.00", glEntry?.amount_cents === "3600", `amount=${glEntry?.amount_cents}`);

    // 6e. REVISE del crédito posteado (vc-edit-mod): 3 → 2 (stock +1), luego 2 → 4 (stock −2),
    //     header-only (sin stock), total < aplicado → 409, y draft → 409.
    const rev1 = await http("POST", `/admin/vendor-credits/${creditId}/revise`, {
      lines: [productLine(fx.polId, 2)],
    });
    const stockAfterRev1 = await stockAt(client, refs.inventory_item_id, refs.location_id);
    const rev1Stock = rev1.json.stock as Json;
    ok("6e. revise 3→2 → 200, stock.moved delta y +1 unidad en la location", rev1.status === 200 && rev1Stock?.moved === true && rev1Stock?.direction === "delta" && stockAfterRev1 === stockAfterPost + 1, JSON.stringify(rev1.json));
    const { rows: revRows } = await client.query<{ total: string; qty: number; revised: string | null }>(
      `SELECT vc.total_cents::text AS total, l.qty, vc.revised_at::text AS revised
         FROM vendor_credit vc JOIN vendor_credit_line l ON l.credit_id = vc.id AND l.deleted_at IS NULL
        WHERE vc.id = $1`,
      [creditId]
    );
    ok("6f. la línea quedó en 2, total 2400, revised_at seteado", revRows[0]?.qty === 2 && revRows[0]?.total === "2400" && !!revRows[0]?.revised, JSON.stringify(revRows[0]));
    const glRev = await activeDocumentEntry(client, "vendor_credit", creditId);
    ok("6g. GL reposteado por $24.00", glRev?.amount_cents === "2400", `amount=${glRev?.amount_cents}`);
    const rev2 = await http("POST", `/admin/vendor-credits/${creditId}/revise`, {
      lines: [productLine(fx.polId, 4)],
    });
    const stockAfterRev2 = await stockAt(client, refs.inventory_item_id, refs.location_id);
    ok("6h. revise 2→4 → 200 y −2 unidades (neto −4 desde el inicio)", rev2.status === 200 && stockAfterRev2 === stockBefore - 4, `before=${stockBefore} after=${stockAfterRev2}`);
    const rev3 = await http("POST", `/admin/vendor-credits/${creditId}/revise`, { reason: "RMA# revised" });
    const rev3Stock = rev3.json.stock as Json;
    ok("6i. revise sólo header → 200 sin mover stock", rev3.status === 200 && rev3Stock?.moved === false, JSON.stringify(rev3.json));
    const applied = await http("POST", `/admin/vendor-credits/${creditId}/apply`, { vendor_bill_id: fx.billId, amount_cents: 4800 });
    const rev4 = await http("POST", `/admin/vendor-credits/${creditId}/revise`, { lines: [productLine(fx.polId, 3)] });
    ok("6j. con $48.00 aplicados, revise a 3 u ($36.00) → 409 exceeds_applications", [200, 201].includes(applied.status) && rev4.status === 409 && rev4.json.code === "exceeds_applications", `apply=${applied.status} ` + JSON.stringify(rev4.json));
    const appId = (applied.json.application as { id?: string } | undefined)?.id ?? "";
    const unapplied = await http("POST", `/admin/vendor-credits/${creditId}/applications/${appId}/void`);
    ok("6k. aplicación voideada para poder seguir", unapplied.status === 200, JSON.stringify(unapplied.json));
    const revDraft = await http("POST", `/admin/vendor-credits/${other.id}/revise`, { reason: "x" });
    ok("6l. revise de un DRAFT → 409 invalid_status (los drafts usan PATCH)", revDraft.status === 409 && revDraft.json.code === "invalid_status", JSON.stringify(revDraft.json));

    // 7. race gate en post: draft C (3 u, cabe: 10−4−4=2 → con 3 NO cabe; usar 2) mutado por SQL a 6
    const draftC = await http("POST", "/admin/vendor-credits", {
      vendor_id: fx.vendor_id,
      credit_date: today,
      purchase_order_id: fx.poId,
      lines: [productLine(fx.polId, 2)],
    });
    const draftCId = (draftC.json.vendor_credit as { id?: string } | undefined)?.id ?? "";
    if (draftCId) createdCreditIds.push(draftCId);
    ok("7a. draft C con 2 (justo cabe: 10 − 4 draft − 4 posted) → 201", draftC.status === 201, JSON.stringify(draftC.json));
    await client.query(`UPDATE vendor_credit_line SET qty = 6, amount_cents = 7200 WHERE credit_id = $1 AND deleted_at IS NULL`, [draftCId]);
    await client.query(`UPDATE vendor_credit SET total_cents = 7200 WHERE id = $1`, [draftCId]);
    const stockBeforeC = await stockAt(client, refs.inventory_item_id, refs.location_id);
    const postC = await http("POST", `/admin/vendor-credits/${draftCId}/post`);
    const stockAfterC = await stockAt(client, refs.inventory_item_id, refs.location_id);
    ok("7b. post de un draft que ya no cabe → 400 exceeds_returnable y el stock no se mueve", postC.status === 400 && postC.json.code === "exceeds_returnable" && stockAfterC === stockBeforeC, JSON.stringify(postC.json));

    // 8. DELETE drafts · DELETE de un posted → 409 · returnable = 7
    const delC = await http("DELETE", `/admin/vendor-credits/${draftCId}`);
    const getC = await http("GET", `/admin/vendor-credits/${draftCId}`);
    const delOther = await http("DELETE", `/admin/vendor-credits/${other.id}`);
    ok("8a. DELETE de los dos drafts → 200 y GET → 404", delC.status === 200 && getC.status === 404 && delOther.status === 200, `${delC.status}/${getC.status}/${delOther.status}`);
    const delPosted = await http("DELETE", `/admin/vendor-credits/${creditId}`);
    ok("8b. DELETE de un posted → 409 invalid_status", delPosted.status === 409 && delPosted.json.code === "invalid_status", JSON.stringify(delPosted.json));
    const ret2 = await http("GET", `/admin/vendor-credits/po-returnable/${fx.poId}`);
    const retLine2 = (ret2.json.lines as Json[]).find((l) => l.purchase_order_line_id === fx.polId);
    ok("8c. returnable ahora 6 (10 − 4 posted tras el revise; los drafts borrados soltaron sus unidades)", retLine2?.qty_returnable === 6 && retLine2?.qty_credited === 4, JSON.stringify(retLine2));

    // 9. void → stock restaurado, marca, GL reversado
    const voided = await http("POST", `/admin/vendor-credits/${creditId}/void`, { reason: "e2e teardown" });
    const stockAfterVoid = await stockAt(client, refs.inventory_item_id, refs.location_id);
    const vStock = voided.json.stock as Json;
    ok("9a. void → 200, stock.moved reverse", voided.status === 200 && vStock?.moved === true && vStock?.direction === "reverse", JSON.stringify(voided.json));
    ok("9b. stock volvió al valor inicial", stockAfterVoid === stockBefore, `before=${stockBefore} afterVoid=${stockAfterVoid}`);
    const { rows: marks2 } = await client.query<{ a: string | null; r: string | null }>(
      `SELECT stock_applied_at::text AS a, stock_reversed_at::text AS r FROM vendor_credit WHERE id = $1`,
      [creditId]
    );
    ok("9c. stock_reversed_at seteado", !!marks2[0]?.a && !!marks2[0]?.r, JSON.stringify(marks2[0]));
    const glAfter = await activeDocumentEntry(client, "vendor_credit", creditId);
    ok("9d. GL: sin entrada activa tras el void", glAfter === null);
  } finally {
    if (fx) {
      // Red de seguridad: si algo falló a mitad de camino y el stock quedó
      // movido, devolverlo por el módulo NO es posible acá (sin container) —
      // se reporta y queda para el operador; el fixture de dominio sí se borra.
      if (refs) {
        const finalStock = await stockAt(client, refs.inventory_item_id, refs.location_id).catch(() => NaN);
        ok("teardown: stock neto cero sobre el fixture", finalStock === stockBefore, `before=${stockBefore} final=${finalStock}`);
      }
      for (const id of createdCreditIds) {
        await client.query(`DELETE FROM vendor_credit_application WHERE credit_id = $1`, [id]).catch(() => {});
        await client.query(`DELETE FROM vendor_credit_line WHERE credit_id = $1`, [id]).catch(() => {});
        await client.query(`DELETE FROM vendor_credit WHERE id = $1`, [id]).catch(() => {});
      }
      await cleanup(client, fx, null, null).catch((e) => console.error("cleanup failed:", e));
    }
    client.release();
    await pool.end();
  }

  console.log(`\n${"═".repeat(64)}\ne2e-vendor-credit-po-return-sandbox: ${checks.filter((c) => c.ok).length}/${checks.length} OK`);
  for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  if (checks.some((c) => !c.ok)) process.exit(1);
}

void main();
