/**
 * E2E — separación vs facturado (2026-08-14). SANDBOX ONLY.
 *
 * ── Qué prueba ───────────────────────────────────────────────────────────────
 *  1. BASELINE — orden abierta sin invoices: la lista (`/admin/orders/filter`,
 *     la ruta de la pantalla) reporta `separation_pending.pending` = qty, y el
 *     modal (`product-status`) coincide.
 *  2. LEGACY (allocator FIFO) — un invoice SIN order_line_item_id insertado por
 *     SQL (la forma de todo invoice pre-2026-08-08) baja `pending` y sube
 *     `invoiced`/`open_qty` del modal SIN ningún evento: la derivación es por
 *     request, no por flag.
 *  3. STAMP (el fix del gate) — un invoice REAL por API por el resto de la
 *     línea dispara pos.invoice.created y el subscriber estampa
 *     metadata.fully_invoiced=true en una orden con CERO separación — el gate
 *     viejo retornaba antes de computar para estas órdenes, exactamente el bug
 *     (S2918). Control positivo: el flag APARECE, no solo "no hay pending".
 *  4. VOID (reversión derivada) — voidear el invoice API dispara
 *     pos.invoice.voided → flag vuelve a false y pending vuelve a 1 (el legacy
 *     sigue cubriendo el resto). Nada que "des-escribir": era derivado.
 *  5. NEGATIVAS — order_line_separation queda VACÍA para la orden (facturar
 *     jamás fabrica separación física) y reservation_item/inventory_level
 *     quedan byte-iguales (facturar no toca stock ni reservas).
 *
 * Todos los writes se revierten (invoices borrados, metadata restaurada).
 *
 * ── Cómo correrlo ────────────────────────────────────────────────────────────
 *   ./back-sb    # backend sandbox en :9099 (con el código NUEVO — reiniciar)
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-separation-invoiced-sandbox.ts
 */
import { Client } from "pg";

const BASE = process.env.SANDBOX_BASE_URL ?? "http://localhost:9099";
const SB_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(why: string): never {
  console.error(`ABORT: ${why}`);
  process.exit(2);
}
if (!SB_DB.includes("5499")) abort("SANDBOX_DATABASE_URL no apunta al sandbox (5499)");
if (!BASE.includes("9099")) abort("SANDBOX_BASE_URL no apunta al sandbox (9099)");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body — status alone decides */
  }
  return { status: res.status, json };
}

async function filterRow(token: string, orderId: string): Promise<any | null> {
  const res = await api(token, "GET", "/admin/orders/filter?tab=all");
  if (res.status !== 200) return null;
  const rows = (res.json?.orders ?? res.json?.rows ?? []) as any[];
  return rows.find((r) => r.id === orderId) ?? null;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs = 20000
): Promise<T | null> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== null) return v;
    if (Date.now() - start > timeoutMs) {
      console.error(`  (timeout esperando: ${what})`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  const loginRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sandbox@test.com", password: "sandbox123" }),
  });
  const token = (await loginRes.json())?.token;
  if (!token) abort("login sandbox falló");

  // ── Fixture: orden pending de UNA línea (qty ≥ 2), sin invoices, sin
  // separación, con variant y customer (el invoice API los necesita) ─────────
  const fx = await db.query(`
    SELECT o.id AS order_id, o.display_id, o.customer_id,
           oli.id AS line_id, oli.variant_id, oli.variant_sku AS sku,
           oli.title AS title, oi.quantity::numeric AS qty
      FROM "order" o
      JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
      JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
     WHERE o.deleted_at IS NULL AND o.status = 'pending' AND o.is_draft_order = false
       AND o.customer_id IS NOT NULL
       AND oli.variant_id IS NOT NULL
       AND oi.quantity::numeric >= 2
       AND COALESCE(oi.fulfilled_quantity::numeric, 0) = 0
       AND NOT EXISTS (SELECT 1 FROM pos_invoice pi
                        WHERE pi.order_id = o.id AND pi.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM order_line_separation s WHERE s.order_id = o.id)
       AND COALESCE(o.metadata->>'is_separated', 'false') <> 'true'
       AND COALESCE(o.metadata->>'fully_invoiced', 'false') <> 'true'
       AND (SELECT COUNT(*) FROM order_item oi2
             WHERE oi2.order_id = o.id AND oi2.version = o.version
               AND oi2.deleted_at IS NULL) = 1
     ORDER BY o.created_at DESC
     LIMIT 10`);
  if (!fx.rows.length) abort("no hay orden fixture (1 línea, sin invoices) en el sandbox");

  // La ruta de la pantalla resuelve membership por Meili: elegir un candidato
  // que el índice del sandbox realmente conozca.
  let f: any = null;
  for (const cand of fx.rows) {
    if (await filterRow(token, cand.order_id)) {
      f = cand;
      break;
    }
  }
  if (!f)
    abort(
      "ningún candidato está en el índice orders del sandbox — correr sync-meili-orders"
    );
  const qty = Number(f.qty);
  console.log(`Fixture: S${f.display_id} (${f.order_id}) línea ${f.line_id} qty ${qty}`);

  const metaBefore = (
    await db.query(`SELECT metadata FROM "order" WHERE id = $1`, [f.order_id])
  ).rows[0].metadata;

  const invSnapshot = async () =>
    (
      await db.query(
        `SELECT md5(string_agg(t.row_text, '|' ORDER BY t.row_text)) AS h
           FROM (
             SELECT id || ':' || COALESCE(quantity::text,'') AS row_text
               FROM reservation_item WHERE deleted_at IS NULL
             UNION ALL
             SELECT id || ':' || COALESCE(stocked_quantity::text,'') || ':' ||
                    COALESCE(reserved_quantity::text,'')
               FROM inventory_level WHERE deleted_at IS NULL
           ) t`
      )
    ).rows[0].h as string;
  const invBefore = await invSnapshot();

  const e2eIds = {
    invoice: `e2esep_inv_${Date.now()}`,
    item: `e2esep_item_${Date.now()}`,
  };
  let apiInvoiceId: string | null = null;

  try {
    // ── 1. Baseline ──────────────────────────────────────────────────────────
    console.log("\n1. Baseline sin invoices");
    const row0 = await filterRow(token, f.order_id);
    check(
      `lista: pending=${qty} (todo por separar)`,
      row0?.separation_pending?.pending === qty,
      JSON.stringify(row0?.separation_pending)
    );
    const ps0 = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
    const line0 = ps0.json?.lines?.find((l: any) => l.line_id === f.line_id);
    check("modal: invoiced=0, open_qty=qty", line0?.invoiced === 0 && line0?.open_qty === qty,
      `invoiced=${line0?.invoiced} open=${line0?.open_qty}`);

    // ── 2. Invoice LEGACY por SQL (sin order_line_item_id, sin evento) ──────
    console.log(`\n2. Invoice legacy por SQL (${qty - 1} unidades, sin line id)`);
    const raw = (v: number) => JSON.stringify({ value: String(v), precision: 20 });
    await db.query(
      `INSERT INTO pos_invoice (id, invoice_number, order_id, customer_id, status,
                                subtotal, discount, shipping, tax, total, amount_paid, balance_due,
                                untaxed_total, refunded_amount, refunded_shipping,
                                raw_subtotal, raw_discount, raw_tax, raw_total, raw_amount_paid, raw_balance_due,
                                created_at, updated_at)
       VALUES ($1, 'E2E-999901', $2, $3, 'paid',
               1000, 0, 0, 0, 1000, 1000, 0,
               1000, 0, 0,
               $4::jsonb, $5::jsonb, $5::jsonb, $4::jsonb, $4::jsonb, $5::jsonb,
               now(), now())`,
      [e2eIds.invoice, f.order_id, f.customer_id, raw(1000), raw(0)]
    );
    await db.query(
      `INSERT INTO pos_invoice_item (id, invoice_id, variant_id, sku, description,
                                     quantity, unit_price, total, refunded_quantity, taxable,
                                     raw_unit_price, raw_total, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'e2e legacy line', $5, 100, 100, 0, true,
               $6::jsonb, $6::jsonb, now(), now())`,
      [e2eIds.item, e2eIds.invoice, f.variant_id, f.sku, qty - 1, raw(100)]
    );

    const row1 = await filterRow(token, f.order_id);
    check(
      "lista: pending=1 (el allocator FIFO descuenta lo facturado sin line id)",
      row1?.separation_pending?.pending === 1,
      JSON.stringify(row1?.separation_pending)
    );
    const ps1 = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
    const line1 = ps1.json?.lines?.find((l: any) => l.line_id === f.line_id);
    check(
      `modal: invoiced=${qty - 1}, open_qty=1 (paridad lista↔modal)`,
      line1?.invoiced === qty - 1 && line1?.open_qty === 1,
      `invoiced=${line1?.invoiced} open=${line1?.open_qty}`
    );
    const flagAfterSql = (
      await db.query(`SELECT metadata->>'fully_invoiced' AS v FROM "order" WHERE id = $1`, [f.order_id])
    ).rows[0].v;
    check("flag sigue ausente (ningún evento corrió — derivación pura)", flagAfterSql === null, `v=${flagAfterSql}`);

    // ── 3. Invoice REAL por API → evento → stamp (el fix) ────────────────────
    console.log("\n3. Invoice real por API (última unidad) → pos.invoice.created");
    const invRes = await api(token, "POST", "/admin/invoices", {
      order_id: f.order_id,
      order_display_id: f.display_id,
      customer_id: f.customer_id,
      items: [
        {
          order_line_item_id: f.line_id,
          variant_id: f.variant_id,
          sku: f.sku ?? undefined,
          description: f.title || f.sku || "e2e line",
          quantity: 1,
          unit_price: 1000,
          total: 1000,
        },
      ],
      subtotal: 1000,
      shipping: 0,
      tax: 0,
      total: 1000,
      amount_paid: 0,
    });
    apiInvoiceId = invRes.json?.invoice?.id ?? null;
    check("invoice API creado", (invRes.status === 200 || invRes.status === 201) && !!apiInvoiceId,
      `status ${invRes.status} ${JSON.stringify(invRes.json).slice(0, 200)}`);

    const stamped = await waitFor("stamp de fully_invoiced tras el evento", async () => {
      const v = (
        await db.query(`SELECT metadata->>'fully_invoiced' AS v FROM "order" WHERE id = $1`, [f.order_id])
      ).rows[0].v;
      return v === "true" ? true : null;
    });
    check(
      "CONTROL POSITIVO: fully_invoiced=true estampado en orden con CERO separación",
      stamped === true
    );
    const row2 = await filterRow(token, f.order_id);
    check(
      "lista: pending=0 con todo facturado",
      row2 === null || row2?.separation_pending?.pending === 0 || row2?.separation_pending == null,
      JSON.stringify(row2?.separation_pending)
    );

    // ── 4. Void → evento → el flag y el pending REVIERTEN solos ─────────────
    console.log("\n4. Void del invoice API → pos.invoice.voided");
    const voidRes = await api(token, "POST", `/admin/invoices/${apiInvoiceId}/void`, {
      reason: "e2e revert",
    });
    check("void 200", voidRes.status === 200, `status ${voidRes.status}`);
    const unstamped = await waitFor("flag vuelve a false tras el void", async () => {
      const v = (
        await db.query(`SELECT metadata->>'fully_invoiced' AS v FROM "order" WHERE id = $1`, [f.order_id])
      ).rows[0].v;
      return v === "false" ? true : null;
    });
    check("flag=false tras void (recompute por evento)", unstamped === true);
    const row3 = await filterRow(token, f.order_id);
    check(
      "lista: pending=1 de nuevo (el legacy sigue cubriendo el resto)",
      row3?.separation_pending?.pending === 1,
      JSON.stringify(row3?.separation_pending)
    );

    // ── 5. Negativas ─────────────────────────────────────────────────────────
    console.log("\n5. Negativas");
    const sepRows = await db.query(
      `SELECT COUNT(*)::int AS n FROM order_line_separation WHERE order_id = $1`,
      [f.order_id]
    );
    check("order_line_separation VACÍA — facturar jamás fabrica separación física",
      sepRows.rows[0].n === 0);
    const invAfter = await invSnapshot();
    check("reservation_item + inventory_level byte-iguales", invAfter === invBefore);
  } finally {
    // ── Revert ───────────────────────────────────────────────────────────────
    console.log("\nRevert del sandbox…");
    await db.query(`DELETE FROM pos_invoice_item WHERE invoice_id = $1`, [e2eIds.invoice]);
    await db.query(`DELETE FROM pos_invoice WHERE id = $1`, [e2eIds.invoice]);
    if (apiInvoiceId) {
      await db.query(`DELETE FROM pos_invoice_item WHERE invoice_id = $1`, [apiInvoiceId]);
      await db.query(`DELETE FROM invoice_payment WHERE invoice_id = $1`, [apiInvoiceId]).catch(() => {});
      await db.query(`DELETE FROM invoice_tracking WHERE invoice_id = $1`, [apiInvoiceId]).catch(() => {});
      await db.query(`DELETE FROM pos_invoice WHERE id = $1`, [apiInvoiceId]);
      await db.query(
        `DELETE FROM qb_order_pipeline WHERE reference_id = $1`,
        [apiInvoiceId]
      ).catch(() => {});
    }
    await db.query(`UPDATE "order" SET metadata = $2::jsonb WHERE id = $1`, [
      f.order_id,
      JSON.stringify(metaBefore ?? {}),
    ]);
    await db.end();
  }

  console.log(`\n${pass} ✓ / ${fail} ✗`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
