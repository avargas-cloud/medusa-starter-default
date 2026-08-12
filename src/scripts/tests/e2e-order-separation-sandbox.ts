/**
 * E2E de la separación por ítem — SANDBOX ONLY.
 *
 * ── Qué prueba ────────────────────────────────────────────────────────────────
 *  1. GET /admin/orders/:id/product-status responde con lines + caps + POs.
 *  2. POST separations parcial → status `partial`, fila en order_line_separation,
 *     metadata.separation_status=partial, is_separated=false (espejo del tab).
 *  3. POST por encima del tope físico → 409 `separation_exceeds_inventory` con
 *     rejections nombrando la línea (control de que la validación EXISTE).
 *  4. POST completo → status `full`, is_separated=true.
 *  5. Legacy: orden con metadata.is_separated=true y CERO filas → GET la lee
 *     como `full` sin migrar nada.
 *  6. NEGATIVAS (la razón de ser del diseño): reservation_item e inventory_level
 *     quedan BYTE-IGUALES — separar es una marca operativa, jamás mueve stock
 *     ni reservas nativas de Medusa (decisión del owner 2026-08-11).
 *
 * El fixture se ELIGE en runtime: una orden viva de la versión actual con ≥1
 * línea con stock físico en Miami (cap > 1). Todos los writes se revierten al
 * final (qty 0 + restaurar metadata), así el sandbox queda como estaba.
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb    # backend sandbox en :9099
 *   ./node_modules/.bin/tsx src/scripts/tests/e2e-order-separation-sandbox.ts
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

async function main() {
  const db = new Client({ connectionString: SB_DB });
  await db.connect();

  // ── Login ──────────────────────────────────────────────────────────────────
  const loginRes = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sandbox@test.com", password: "sandbox123" }),
  });
  const token = (await loginRes.json())?.token;
  if (!token) abort("login sandbox falló");

  // ── Fixture: orden con una línea físicamente separable (cap ≥ 2) ───────────
  const fx = await db.query(`
    SELECT o.id AS order_id, oli.id AS line_id, oi.quantity::numeric AS qty,
           il.stocked_quantity::numeric AS stocked
      FROM "order" o
      JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
      JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      JOIN product_variant_inventory_item pvii
        ON pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL
      JOIN inventory_level il
        ON il.inventory_item_id = pvii.inventory_item_id
       AND il.deleted_at IS NULL
       AND il.stocked_quantity - il.reserved_quantity >= 2
      LEFT JOIN order_line_separation sep
        ON sep.order_id = o.id AND sep.order_line_item_id = oli.id
      LEFT JOIN LATERAL (
           SELECT SUM(pii.quantity) AS qty
             FROM pos_invoice_item pii
             JOIN pos_invoice pi
               ON pi.id = pii.invoice_id
              AND pi.deleted_at IS NULL AND pi.status <> 'voided'
            WHERE pii.order_line_item_id = oli.id AND pii.deleted_at IS NULL
      ) inv ON true
     WHERE o.deleted_at IS NULL AND o.status NOT IN ('canceled', 'archived')
       AND COALESCE(inv.qty, 0) = 0
       AND COALESCE(o.metadata->>'fully_invoiced', 'false') <> 'true'
       AND oi.quantity::numeric >= 2
       -- full alcanzable: la orden tiene UNA sola línea y el stock libre la cubre
       AND oi.quantity::numeric <= il.stocked_quantity - il.reserved_quantity
       AND (SELECT COUNT(*) FROM order_item oi2
             WHERE oi2.order_id = o.id AND oi2.version = o.version
               AND oi2.deleted_at IS NULL) = 1
       AND COALESCE(oi.fulfilled_quantity::numeric, 0) = 0
       AND sep.id IS NULL
       AND COALESCE(o.metadata->>'is_separated', 'false') <> 'true'
     ORDER BY o.created_at DESC
     LIMIT 1`);
  const f = fx.rows[0];
  if (!f) abort("no hay orden fixture con stock separable en el sandbox");
  console.log(`Fixture: ${f.order_id} línea ${f.line_id} (qty ${f.qty}, stocked ${f.stocked})`);

  const metaBefore = (
    await db.query(`SELECT metadata FROM "order" WHERE id = $1`, [f.order_id])
  ).rows[0].metadata;

  // Foto ANTES de reservas e inventario — la assertion negativa del final.
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

  // ── 1. GET product-status ──────────────────────────────────────────────────
  console.log("\n1. GET product-status");
  const ps = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
  check("responde 200", ps.status === 200, `status ${ps.status}`);
  check("trae lines[]", Array.isArray(ps.json?.lines) && ps.json.lines.length > 0);
  check("trae purchase_orders[]", Array.isArray(ps.json?.purchase_orders));
  const line = ps.json?.lines?.find((l: any) => l.line_id === f.line_id);
  check("la línea fixture está", !!line);
  const cap = Number(line?.separable_cap ?? 0);
  check("cap físico ≥ 2", cap >= 2, `cap ${cap}`);
  check("status inicial none", ps.json?.order?.separation_status === "none");

  // ── 2. Separación parcial ──────────────────────────────────────────────────
  console.log("\n2. POST parcial (1 unidad)");
  const partial = await api(token, "POST", `/admin/orders/${f.order_id}/separations`, {
    separations: [{ line_id: f.line_id, qty: 1 }],
  });
  check("responde 200", partial.status === 200, `status ${partial.status}`);
  check("status partial", partial.json?.separation_status === "partial");
  check("is_separated=false (espejo)", partial.json?.is_separated === false);
  const row = await db.query(
    `SELECT qty::numeric AS qty, updated_by FROM order_line_separation
      WHERE order_id = $1 AND order_line_item_id = $2`,
    [f.order_id, f.line_id]
  );
  check("fila escrita qty=1", Number(row.rows[0]?.qty) === 1);
  check("updated_by estampado", !!row.rows[0]?.updated_by);
  const metaP = (
    await db.query(`SELECT metadata FROM "order" WHERE id = $1`, [f.order_id])
  ).rows[0].metadata;
  check("metadata.separation_status=partial", metaP?.separation_status === "partial");
  check("metadata.is_separated=false", metaP?.is_separated === false);

  // ── 3. Sobre-cap → 409 ─────────────────────────────────────────────────────
  console.log("\n3. POST sobre el tope físico");
  const over = await api(token, "POST", `/admin/orders/${f.order_id}/separations`, {
    separations: [{ line_id: f.line_id, qty: 999999 }],
  });
  check("responde 409", over.status === 409, `status ${over.status}`);
  check(
    "error separation_exceeds_inventory",
    over.json?.error === "separation_exceeds_inventory"
  );
  check(
    "rejections nombra la línea",
    Array.isArray(over.json?.rejections) &&
      over.json.rejections.some((r: any) => r.lineId === f.line_id)
  );
  const rowAfter409 = await db.query(
    `SELECT qty::numeric AS qty FROM order_line_separation
      WHERE order_id = $1 AND order_line_item_id = $2`,
    [f.order_id, f.line_id]
  );
  check("el 409 no escribió nada (sigue 1)", Number(rowAfter409.rows[0]?.qty) === 1);

  // ── 4. Separación completa ─────────────────────────────────────────────────
  console.log("\n4. POST completo");
  // Cubrir TODAS las líneas abiertas de la orden hasta su tope: si alguna otra
  // línea no tiene respaldo físico, full es inalcanzable — el test lo detecta
  // pidiendo el estado que el server derive, no asumiendo.
  const psNow = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
  const wanted = (psNow.json?.lines ?? [])
    .filter((l: any) => Number(l.open_qty) > 0)
    .map((l: any) => ({
      line_id: l.line_id,
      qty: Math.min(Number(l.open_qty), Math.max(Number(l.separable_cap), Number(l.separated))),
    }));
  const allBacked = (psNow.json?.lines ?? []).every(
    (l: any) => Number(l.separable_cap) >= Number(l.open_qty) || Number(l.open_qty) === 0
  );
  const full = await api(token, "POST", `/admin/orders/${f.order_id}/separations`, {
    separations: wanted,
  });
  check("responde 200", full.status === 200, `status ${full.status}`);
  if (allBacked) {
    check("status full", full.json?.separation_status === "full");
    check("is_separated=true", full.json?.is_separated === true);
  } else {
    check(
      "status partial (hay líneas sin respaldo físico — full inalcanzable, correcto)",
      full.json?.separation_status === "partial"
    );
  }

  // ── 5. Legacy flag sin filas ───────────────────────────────────────────────
  console.log("\n5. Legacy boolean sin filas");
  const legacy = await db.query(`
    SELECT o.id FROM "order" o
     WHERE o.deleted_at IS NULL
       AND o.metadata->>'is_separated' = 'true'
       AND o.metadata->>'separation_status' IS NULL
       AND NOT EXISTS (SELECT 1 FROM order_line_separation s WHERE s.order_id = o.id)
     LIMIT 1`);
  if (legacy.rows[0]) {
    const lg = await api(
      token,
      "GET",
      `/admin/orders/${legacy.rows[0].id}/product-status`
    );
    check("legacy se lee full", lg.json?.order?.separation_status === "full");
    check("legacy_separated_flag=true", lg.json?.order?.legacy_separated_flag === true);
  } else {
    console.log("  (sin órdenes legacy separated en el sandbox — caso cubierto por unit spec)");
  }

  // ── 5b. Lo facturado no aparece: orden fully_invoiced → todo open_qty 0 ────
  console.log("\n5b. Orden facturada queda sin trabajo pendiente");
  const invoiced = await db.query(`
    SELECT id FROM "order"
     WHERE deleted_at IS NULL
       AND metadata->>'fully_invoiced' = 'true'
     ORDER BY created_at DESC LIMIT 1`);
  if (invoiced.rows[0]) {
    const iv = await api(
      token,
      "GET",
      `/admin/orders/${invoiced.rows[0].id}/product-status`
    );
    const allZero = (iv.json?.lines ?? []).every(
      (l: any) => Number(l.open_qty) === 0
    );
    check("fully_invoiced: toda línea open_qty=0", allZero);
  } else {
    console.log("  (sin órdenes fully_invoiced en el sandbox)");
  }

  // ── 6. NEGATIVAS: reservas e inventario intactos ───────────────────────────
  console.log("\n6. Reservas e inventario intactos");
  const invAfter = await invSnapshot();
  check(
    "reservation_item + inventory_level byte-iguales",
    invBefore === invAfter,
    "¡la separación tocó reservas o stock!"
  );

  // ── Cleanup: volver el sandbox a como estaba ───────────────────────────────
  await db.query(
    `DELETE FROM order_line_separation WHERE order_id = $1`,
    [f.order_id]
  );
  await db.query(`UPDATE "order" SET metadata = $2::jsonb WHERE id = $1`, [
    f.order_id,
    JSON.stringify(metaBefore ?? {}),
  ]);
  console.log("\nCleanup: filas borradas y metadata restaurado");

  await db.end();
  console.log(`\n${pass}/${pass + fail} PASS`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
