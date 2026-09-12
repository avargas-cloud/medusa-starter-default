/**
 * verify-write-smoke — el gate que faltó en la subida 2.13→2.16.
 *
 * Ejercita las ESCRITURAS reales del POS por las rutas HTTP que usa la app, contra
 * cualquier instancia (sandbox aislado o producción), y afirma que cada fila
 * quedó persistida con sus columnas derivadas (`seq`, `raw_*`) pobladas. Existe
 * porque el 2026-09-10 MikroORM 6.6 empezó a mandar `null` explícito en INSERT y
 * el BIGSERIAL `seq` de dos pipelines de QB violó NOT NULL: build, type-check,
 * 1157 unit tests y dinero bit-idéntico estaban verdes, y nadie había CREADO nada.
 *
 * Plan: docs/MEDUSA_UPGRADE_2_21_PLAN.md (gate 2).
 *
 *   API_URL=http://localhost:9221 DATABASE_URL=postgresql://...medusa221 \
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... \
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-write-smoke.ts [--scope=safe|full]
 *
 *   safe (default): producto · vendor · estimado · PO · vendor bill — todos con
 *                   ruta de borrado/void; apto para PRODUCCIÓN en el checkpoint.
 *   full:           + convertir a orden · factura · pago · credit memo. Deja filas
 *                   que se limpian por SQL: SÓLO sandbox (exige ECOPOWERTECH_ENV
 *                   distinto de production en la instancia).
 *
 * Con ADMIN_TOKEN seteado no hace login (prod: el token se le PIDE al operador).
 * Salida: una línea ✓/✗ por aserción y exit 1 si alguna falla. Nunca es muda.
 */
import { Pool } from "pg";

const API = process.env.API_URL ?? "http://localhost:9221";
const DB = process.env.DATABASE_URL;
const SCOPE = (process.argv.find((a) => a.startsWith("--scope="))?.split("=")[1] ?? "safe") as "safe" | "full";
const TAG = `SMOKE-${Date.now().toString(36).toUpperCase()}`;

if (!DB) {
  console.error("DATABASE_URL requerido");
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

type Json = Record<string, unknown>;
let token = process.env.ADMIN_TOKEN ?? "";

async function api<T = Json>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    body = { raw: text.slice(0, 300) } as unknown as T;
  }
  return { status: res.status, body };
}

async function login(): Promise<void> {
  if (token) return;
  const email = process.env.SMOKE_EMAIL ?? "sandbox@test.com";
  const password = process.env.SMOKE_PASSWORD ?? "sandbox123";
  const r = await api<{ token?: string }>("/auth/user/emailpass", { method: "POST", body: { email, password } });
  if (!r.body.token) throw new Error(`login falló (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  token = r.body.token;
}

async function one<T>(db: Pool, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await db.query(sql, params);
  return rows[0] as T | undefined;
}

async function main(): Promise<void> {
  const db = new Pool({ connectionString: DB });
  const created: { kind: string; id: string }[] = [];
  console.log(`verify-write-smoke · ${API} · scope=${SCOPE} · tag=${TAG}`);

  const envRow = await api<{ env?: string; ecopowertech_env?: string }>("/health");
  if (SCOPE === "full") {
    const isProd = /production/i.test(JSON.stringify(envRow.body)) || /railway/.test(API);
    if (isProd) throw new Error("scope=full está prohibido contra producción");
  }
  await login();

  // Fixtures que ya existen en la base (no se crean acá): región, ubicación, variante viva.
  const region = await one<{ id: string }>(db, `SELECT id FROM region WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`);
  const loc = await one<{ id: string }>(db, `SELECT id FROM stock_location WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`);
  const variant = await one<{ id: string; sku: string; title: string; inventory_item_id: string }>(
    db,
    `SELECT pv.id, pv.sku, pv.title, pvii.inventory_item_id
       FROM product_variant pv
       JOIN product p ON p.id = pv.product_id AND p.deleted_at IS NULL AND p.status = 'published'
       JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
      WHERE pv.deleted_at IS NULL AND pv.sku IS NOT NULL
      ORDER BY pv.created_at DESC LIMIT 1`
  );
  const customer = await one<{ id: string; email: string }>(db, `SELECT id, email FROM customer WHERE deleted_at IS NULL AND email IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  check("fixtures: región, ubicación, variante y cliente existen", !!(region && loc && variant && customer));
  if (!region || !loc || !variant || !customer) throw new Error("sin fixtures");

  // ── 1. Vendor ─────────────────────────────────────────────────────────────
  console.log("\n1. Vendor (POST /admin/qb-catalog/vendors)");
  const vendorName = `${TAG} Vendor`;
  const v = await api<{ vendor?: { id: string } }>("/admin/qb-catalog/vendors", { method: "POST", body: { name: vendorName, company_name: vendorName } });
  const vendorId = v.body.vendor?.id ?? (v.body as Json).id;
  // Con el bridge apagado la ruta contesta 502 "saved locally but QB sync failed":
  // el vendor y su fila de pipeline YA se insertaron. Lo que no puede aparecer es
  // el error del ORM (seq / NOT NULL), que ocurre ANTES de hablar con el bridge.
  const vText = JSON.stringify(v.body);
  check("vendor persistido (2xx, o 502 sólo por bridge apagado)", !!vendorId && (v.status < 300 || /QB sync failed/.test(vText)) && !/Cannot set field|NOT NULL|violates/i.test(vText), `${v.status} ${vText.slice(0, 160)}`);
  if (vendorId) created.push({ kind: "vendor", id: String(vendorId) });
  const vpipe = await one<{ seq: string | null }>(db, `SELECT seq::text FROM qb_vendor_pipeline WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 1`, [vendorId]);
  check("qb_vendor_pipeline: fila con seq poblado", !!vpipe && vpipe.seq !== null, JSON.stringify(vpipe));

  // ── 2. Producto ───────────────────────────────────────────────────────────
  console.log("\n2. Producto (POST /admin/pos/products)");
  const sku = `${TAG}-SKU`;
  const p = await api<{ product?: { id: string }; variant?: { id: string } }>("/admin/pos/products", {
    method: "POST",
    body: { title: `${TAG} Item`, sku, cost: 12.5, vendor: vendorName, vendor_qb_id: vendorId, mpn: `${TAG}-MPN`, retail_price: 25, wholesale_price: 20 },
  });
  const productId = p.body.product?.id;
  const pText = JSON.stringify(p.body);
  const bridgeOff = p.status >= 400 && /fetch failed|Bridge .* timed out|ECONNREFUSED/.test(pText);
  // sendToQbStep inserta la fila de qb_item_pipeline ANTES del bridge: con el bridge
  // apagado el workflow compensa (borra producto y fila) y contesta "fetch failed".
  // El bug del 2026-09-10 se manifiesta acá como "Cannot set field 'seq' ... to null".
  check("producto: INSERT de producto + pipeline pasó (2xx, o fallo SÓLO del bridge)", (p.status < 300 && !!productId) || bridgeOff, `${p.status} ${pText.slice(0, 200)}`);
  check("producto: sin error de ORM en seq/NOT NULL", !/Cannot set field|NOT NULL|violates/i.test(pText), pText.slice(0, 200));
  if (productId) created.push({ kind: "product", id: productId });
  if (productId) {
    const ipipe = await one<{ seq: string | null }>(db, `SELECT seq::text FROM qb_item_pipeline WHERE sku = $1 ORDER BY created_at DESC LIMIT 1`, [sku]);
    check("qb_item_pipeline: fila con seq poblado", !!ipipe && ipipe.seq !== null, JSON.stringify(ipipe));
  } else {
    console.log("  ℹ bridge apagado: la fila de pipeline fue compensada; verify-qb-pipeline-seq-default.ts cubre el INSERT directo (gate 2b)");
  }

  // ── 3. Estimado (draft order por el camino del POS) ───────────────────────
  console.log("\n3. Estimado (POST /admin/draft-orders/sync-pos)");
  const est = await api<{ draft_order_id?: string }>("/admin/draft-orders/sync-pos", {
    method: "POST",
    body: {
      action: "create",
      id: null,
      payload: { email: customer.email, customer_id: customer.id, metadata: { pos_created: true, document_number: `${TAG}-E` } },
      items: [{ localId: "l0", variantId: variant.id, quantity: 1, effectiveUnitPrice: 10, unitPrice: 10, lineDiscount: 0, title: variant.title ?? variant.sku, salesDescription: "", sortOrder: 0, priceListId: null, priceListLabel: "Default" }],
      shipping_price: 0,
      customer_id: customer.id,
    },
  });
  const draftId = est.body.draft_order_id;
  check("estimado creado", est.status < 300 && !!draftId, `${est.status} ${JSON.stringify(est.body).slice(0, 200)}`);
  if (draftId) created.push({ kind: "draft_order", id: draftId });
  if (draftId) {
    const tax = await api(`/admin/draft-orders/${draftId}/compute-tax`, { method: "POST", body: { mode: "florida" } });
    check("compute-tax (florida) 2xx", tax.status < 300, `${tax.status} ${JSON.stringify(tax.body).slice(0, 120)}`);
    const row = await one<{ total: string | null; items: string }>(db, `SELECT COALESCE(NULLIF(o.metadata->>'computed_total',''), os.totals->>'current_order_total') AS total, (SELECT count(*) FROM order_item oi JOIN order_line_item li ON li.id=oi.item_id WHERE oi.order_id=o.id)::text AS items FROM "order" o LEFT JOIN order_summary os ON os.order_id=o.id AND os.version=o.version WHERE o.id=$1`, [draftId]);
    check("estimado: 1 línea y order_summary con total > 0", !!row && row.items === "1" && Number(row.total) > 0, JSON.stringify(row));
  }

  // ── 4. Purchase order ─────────────────────────────────────────────────────
  console.log("\n4. PO (POST /admin/purchase-orders)");
  const po = await api<{ purchase_order?: { id: string; number: string | null } }>("/admin/purchase-orders", {
    method: "POST",
    body: {
      vendor_id: vendorId,
      stock_location_id: loc.id,
      lines: [{ product_variant_id: variant.id, inventory_item_id: variant.inventory_item_id, sku_snapshot: variant.sku, description_snapshot: variant.title ?? variant.sku, qty_ordered: 1, unit_cost_cents: 1000, line_order: 0 }],
    },
  });
  const poId = po.body.purchase_order?.id;
  check("PO creado con número", po.status < 300 && !!poId && !!po.body.purchase_order?.number, `${po.status} ${JSON.stringify(po.body).slice(0, 200)}`);
  if (poId) created.push({ kind: "purchase_order", id: poId });
  // Un PO nace como borrador `D-N` (custom_po_draft_seq); el `PO-{seq}` se asigna al submit.
  const poRow = await one<{ number: string | null; status: string }>(db, `SELECT number, status FROM purchase_order WHERE id=$1`, [poId]);
  check("purchase_order: número de borrador D-N asignado por secuencia", !!poRow && /^D-\d+$/.test(poRow.number ?? "") && poRow.status === "draft", JSON.stringify(poRow));

  // ── 5. Vendor bill (freight, sin PO) ──────────────────────────────────────
  console.log("\n5. Vendor bill (POST /admin/vendor-bills)");
  const acct = await one<{ list_id: string }>(db, `SELECT qb_list_id AS list_id FROM qb_account WHERE is_active AND deleted_at IS NULL AND account_type = 'CostOfGoodsSold' AND lower(full_name) LIKE 'freight and shipping costs%' ORDER BY full_name LIMIT 1`);
  const vb = await api<{ vendor_bill?: { id: string; number?: string } }>("/admin/vendor-bills", {
    method: "POST",
    body: { vendor_id: vendorId, bill_type: "freight", reference_id: `${TAG}-VB`, commission_mode: "percent", notes: "smoke — descartable", initial_account_line: { qb_account_list_id: acct?.list_id, description: "smoke", amount_cents: 1000 } },
  });
  const vbId = vb.body.vendor_bill?.id;
  check("vendor bill creado", vb.status < 300 && !!vbId, `${vb.status} ${JSON.stringify(vb.body).slice(0, 200)}`);
  if (vbId) created.push({ kind: "vendor_bill", id: vbId });

  // ── 6. (full) orden → factura → pago ──────────────────────────────────────
  if (SCOPE === "full" && draftId) {
    console.log("\n6. Orden → factura → pago (scope=full)");
    const conv = await api(`/admin/draft-orders/${draftId}/convert-force`, { method: "POST", body: {} });
    check("convert-force 2xx", conv.status < 300, `${conv.status} ${JSON.stringify(conv.body).slice(0, 160)}`);
    const ord = await one<{ status: string; total: string | null }>(db, `SELECT o.status, os.totals->>'current_order_total' AS total FROM "order" o LEFT JOIN order_summary os ON os.order_id=o.id AND os.version=o.version WHERE o.id=$1`, [draftId]);
    check("orden confirmada con total", !!ord && ord.status !== "draft" && Number(ord.total) > 0, JSON.stringify(ord));
    const disp = await one<{ display_id: string }>(db, `SELECT display_id::text FROM "order" WHERE id=$1`, [draftId]);
    const total = Number(ord?.total ?? 0);
    const inv = await api<{ invoice?: { id: string; number?: string } }>("/admin/invoices", {
      method: "POST",
      body: {
        order_id: draftId, order_display_id: disp?.display_id, customer_id: customer.id, order_document_number: `${TAG}-E`,
        items: [{ variant_id: variant.id, sku: variant.sku, description: variant.title ?? variant.sku, quantity: 1, unit_price: 10, total: 10, net_total: 10 }],
        subtotal: 10, discount: 0, shipping: 0, tax: Math.max(0, total - 10), total, amount_paid: 0, payment_method: null, send_email: false, is_sales_receipt: false,
      },
    });
    const invId = inv.body.invoice?.id;
    check("factura creada", inv.status < 300 && !!invId, `${inv.status} ${JSON.stringify(inv.body).slice(0, 200)}`);
    if (invId) created.push({ kind: "invoice", id: invId });
    const pay = await api<{ payment?: { id: string } }>("/admin/customer-payments", {
      method: "POST",
      body: { customer_id: customer.id, amount: 100, method: "cash", reference: TAG, notes: "smoke" },
    });
    const payId = pay.body.payment?.id;
    check("pago de cliente creado", pay.status < 300 && !!payId, `${pay.status} ${JSON.stringify(pay.body).slice(0, 200)}`);
    if (payId) created.push({ kind: "customer_payment", id: payId });
    const payRow = await one<{ amount: string; raw: unknown }>(db, `SELECT amount::text, raw_amount AS raw FROM customer_payment WHERE id=$1`, [payId]);
    check("customer_payment.amount y raw_amount coherentes", !!payRow && Number(payRow.amount) === 100 && payRow.raw !== null, JSON.stringify(payRow));
  }

  // ── Limpieza ──────────────────────────────────────────────────────────────
  console.log("\nLimpieza");
  for (const c of created.reverse()) {
    let ok = false;
    let detail = "";
    try {
      if (c.kind === "vendor_bill") ok = (await api(`/admin/vendor-bills/${c.id}`, { method: "DELETE" })).status < 300;
      else if (c.kind === "purchase_order") ok = (await api(`/admin/purchase-orders/${c.id}`, { method: "DELETE" })).status < 300;
      else if (c.kind === "draft_order" && SCOPE === "safe") ok = (await api(`/admin/draft-orders/${c.id}`, { method: "DELETE" })).status < 300;
      else if (c.kind === "product") ok = (await api(`/admin/products/${c.id}`, { method: "DELETE" })).status < 300;
      else if (c.kind === "vendor") {
        // No hay DELETE de vendor por ruta: borrado directo (soft) del catálogo local.
        // En prod (scope=safe) queda un vendor "SMOKE-*" pending_ que se borra a mano
        // en el checkpoint — el script lo lista al final.
        if (SCOPE === "full") { await db.query(`DELETE FROM qb_vendor_pipeline WHERE vendor_id=$1`, [c.id]); await db.query(`DELETE FROM qb_vendor WHERE id=$1`, [c.id]); ok = true; }
        else { console.log(`  ℹ vendor ${c.id} (${TAG}) queda: borrar a mano en el checkpoint`); ok = true; }
      }
      else if (SCOPE === "full") {
        // Filas de dinero: sólo sandbox, borrado directo (las rutas no borran órdenes cobradas).
        const table = { draft_order: `"order"`, invoice: "pos_invoice", customer_payment: "customer_payment" }[c.kind];
        if (table) {
          if (c.kind === "invoice") await db.query(`DELETE FROM pos_invoice_item WHERE invoice_id = $1`, [c.id]);
          await db.query(`DELETE FROM ${table} WHERE id = $1`, [c.id]);
          ok = true;
        }
      }
    } catch (e) {
      detail = (e as Error).message;
    }
    check(`borrado ${c.kind} ${c.id}`, ok, detail);
  }
  const leftovers = await one<{ n: string }>(db, `SELECT count(*)::text AS n FROM qb_item_pipeline WHERE sku LIKE $1`, [`${TAG}%`]);
  if (SCOPE === "full") await db.query(`DELETE FROM qb_item_pipeline WHERE sku LIKE $1`, [`${TAG}%`]);
  console.log(`  ℹ filas de pipeline con tag: ${leftovers?.n ?? "?"} (se conservan en safe: son auditoría de QB)`);

  await db.end();
  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`} · verify-write-smoke · ${TAG}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("✗ abortado:", (e as Error).message);
  process.exit(1);
});
