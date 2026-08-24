/**
 * E2E de la separación por ítem — SANDBOX ONLY.
 *
 * ── Qué prueba ────────────────────────────────────────────────────────────────
 *  1. GET /admin/orders/:id/product-status responde con lines + caps + POs.
 *  2. POST separations parcial → status `partial`, fila en order_line_separation,
 *     metadata.separation_status=partial, is_separated=false (espejo del tab).
 *  3. POST por encima del tope físico → 409 `separation_exceeds_inventory` con
 *     rejections nombrando la línea (control de que la validación EXISTE).
 *  3b. CROSS-ORDEN (owner 2026-08-12): una separación VIVA en otra orden del
 *     mismo inventory item achica `separated_elsewhere`/`separable_cap` y sale
 *     en `separations_elsewhere` (tooltip); llevarla a live 0 (equivalente a
 *     entregada) o cancelar la otra orden la LIBERA; con la otra orden
 *     acaparando todo el stock, subir la separación propia da 409.
 *  3c. ROUND-TRIP con entrega PARCIAL: la columna vive en el eje ORDENADO y el
 *     modal habla en unidades de estante — guardar N tiene que releerse N, y la
 *     columna tiene que quedar en N + despachado. Es el único caso donde la
 *     conversión existe, y el fixture de abajo (fulfilled = 0) era ciego a él.
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
           il.stocked_quantity::numeric AS stocked,
           pvii.inventory_item_id AS item_id
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

  // Activity Log: el save deja una huella nativa con actor y deltas por SKU
  // (delta v3 2026-08-12 — el owner rastrea quién separa qué).
  const actRows = await db.query(
    `SELECT internal_note, created_by FROM order_change
      WHERE order_id = $1 AND change_type = 'pos_activity'
        AND internal_note LIKE '__pos_activity__%separation_saved%'
      ORDER BY created_at DESC`,
    [f.order_id]
  );
  check("pos_activity separation_saved escrita", actRows.rows.length === 1);
  check("actividad con actor", !!actRows.rows[0]?.created_by);
  let actPayload: any = null;
  try {
    actPayload = JSON.parse(
      String(actRows.rows[0]?.internal_note ?? "").slice("__pos_activity__".length)
    );
  } catch {
    /* check de abajo lo reporta */
  }
  check(
    "actividad: delta 0→1 del SKU",
    Array.isArray(actPayload?.changes) &&
      actPayload.changes.some((c: any) => c.from === 0 && c.to === 1),
    JSON.stringify(actPayload?.changes)
  );
  check("actividad: status partial", actPayload?.status === "partial");

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

  // ── 3b. Cross-orden: separación viva en OTRA orden achica el cap ───────────
  console.log("\n3b. Separación viva en otra orden");
  const other = (
    await db.query(
      `SELECT o.id AS order_id, o.display_id, oli.id AS line_id,
              COALESCE(oi.fulfilled_quantity::numeric, 0) AS fulfilled,
              o.status AS status
         FROM "order" o
         JOIN order_item oi
           ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
         JOIN order_line_item oli
           ON oli.id = oi.item_id AND oli.deleted_at IS NULL
         JOIN product_variant_inventory_item pvii
           ON pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL
         LEFT JOIN order_line_separation sep
           ON sep.order_id = o.id AND sep.order_line_item_id = oli.id
        WHERE pvii.inventory_item_id = $1
          AND o.id <> $2
          AND o.deleted_at IS NULL
          AND o.status NOT IN ('canceled', 'archived')
          AND sep.id IS NULL
        ORDER BY o.created_at DESC
        LIMIT 1`,
      [f.item_id, f.order_id]
    )
  ).rows[0];
  if (!other) {
    console.log("  (ninguna otra orden comparte el inventory item — sección salteada)");
  } else {
    const otherFulfilled = Number(other.fulfilled);
    const readLine = async () => {
      const r = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
      return r.json?.lines?.find((l: any) => l.line_id === f.line_id);
    };
    const base3b = await readLine();
    const elseBase = Number(base3b?.separated_elsewhere ?? 0);
    const capBase = Number(base3b?.separable_cap ?? 0);

    // La otra orden aparta 2 unidades VIVAS (qty total = fulfilled + 2, así el
    // remanente es exactamente 2 tenga o no entregas previas esa línea).
    await db.query(
      `INSERT INTO order_line_separation (order_id, order_line_item_id, qty, updated_by)
       VALUES ($1, $2, $3, 'e2e-cross-order')
       ON CONFLICT (order_id, order_line_item_id)
       DO UPDATE SET qty = EXCLUDED.qty, updated_at = now()`,
      [other.order_id, other.line_id, otherFulfilled + 2]
    );
    const withElse = await readLine();
    check(
      "separated_elsewhere sube exactamente 2",
      Number(withElse?.separated_elsewhere) === elseBase + 2,
      `antes ${elseBase}, ahora ${withElse?.separated_elsewhere}`
    );
    const expectedCap = Math.min(
      Number(withElse?.open_qty ?? 0),
      Math.max(0, Number(withElse?.miami_stocked ?? 0) - Number(withElse?.separated_elsewhere ?? 0))
    );
    check(
      "separable_cap = min(open, stocked − elsewhere)",
      Number(withElse?.separable_cap) === expectedCap,
      `cap ${withElse?.separable_cap}, esperado ${expectedCap}`
    );
    const tip = (withElse?.separations_elsewhere ?? []).find(
      (r: any) => r.order_id === other.order_id
    );
    check("tooltip trae la otra orden", !!tip);
    check(
      "tooltip: separated vivo = 2",
      Number(tip?.separated) === 2,
      `separated ${tip?.separated}`
    );
    check(
      "tooltip: display_id de la otra orden",
      tip?.display_id === other.display_id,
      `display ${tip?.display_id} vs ${other.display_id}`
    );
    check("tooltip: customer_name presente", typeof tip?.customer_name === "string" && tip.customer_name.length > 0);

    // Entregada = liberada: live 0 (qty == fulfilled) saca la fila del pool y
    // del tooltip sin borrar nada.
    await db.query(
      `UPDATE order_line_separation SET qty = $3
        WHERE order_id = $1 AND order_line_item_id = $2`,
      [other.order_id, other.line_id, otherFulfilled]
    );
    const released = await readLine();
    check(
      "live 0 libera el pool",
      Number(released?.separated_elsewhere) === elseBase,
      `elsewhere ${released?.separated_elsewhere}, esperado ${elseBase}`
    );
    check(
      "live 0 restaura el cap",
      Number(released?.separable_cap) === capBase,
      `cap ${released?.separable_cap}, esperado ${capBase}`
    );

    // Overdraw: la otra orden acapara todo el stock → subir la propia da 409.
    await db.query(
      `UPDATE order_line_separation SET qty = $3
        WHERE order_id = $1 AND order_line_item_id = $2`,
      [other.order_id, other.line_id, otherFulfilled + Number(f.stocked) + 999]
    );
    const starved = await readLine();
    check(
      "acaparado: cap propio 0",
      Number(starved?.separable_cap) === 0,
      `cap ${starved?.separable_cap}`
    );
    const raise = await api(token, "POST", `/admin/orders/${f.order_id}/separations`, {
      separations: [{ line_id: f.line_id, qty: 2 }],
    });
    check("subir la propia → 409", raise.status === 409, `status ${raise.status}`);
    const actBefore = (
      await db.query(
        `SELECT COUNT(*)::int AS n FROM order_change
          WHERE order_id = $1 AND internal_note LIKE '__pos_activity__%separation_saved%'`,
        [f.order_id]
      )
    ).rows[0].n;
    const keep = await api(token, "POST", `/admin/orders/${f.order_id}/separations`, {
      separations: [{ line_id: f.line_id, qty: 1 }],
    });
    check(
      "mantener el valor guardado NUNCA se rechaza",
      keep.status === 200,
      `status ${keep.status}`
    );
    const actAfter = (
      await db.query(
        `SELECT COUNT(*)::int AS n FROM order_change
          WHERE order_id = $1 AND internal_note LIKE '__pos_activity__%separation_saved%'`,
        [f.order_id]
      )
    ).rows[0].n;
    check(
      "guardar sin cambios NO deja huella de actividad",
      actAfter === actBefore,
      `antes ${actBefore}, después ${actAfter}`
    );

    // Cancelada = liberada: el status de la otra orden la saca del pool.
    await db.query(`UPDATE "order" SET status = 'canceled' WHERE id = $1`, [
      other.order_id,
    ]);
    const freed = await readLine();
    check(
      "orden cancelada libera el pool",
      Number(freed?.separated_elsewhere) === elseBase,
      `elsewhere ${freed?.separated_elsewhere}, esperado ${elseBase}`
    );
    await db.query(`UPDATE "order" SET status = $2 WHERE id = $1`, [
      other.order_id,
      other.status,
    ]);
    await db.query(
      `DELETE FROM order_line_separation
        WHERE order_id = $1 AND order_line_item_id = $2`,
      [other.order_id, other.line_id]
    );
    const clean = await readLine();
    check(
      "cleanup 3b: cap de vuelta al baseline",
      Number(clean?.separable_cap) === capBase,
      `cap ${clean?.separable_cap}, esperado ${capBase}`
    );
  }

  // ── 3c. ROUND-TRIP sobre una línea PARCIALMENTE despachada ────────────────
  //
  // La razón de ser de esta sección: el fixture de arriba exige
  // `fulfilled_quantity = 0`, así que TODO este E2E era estructuralmente ciego
  // al único caso donde la conversión neto↔bruto existe. Con `fulfilled = 0`
  // las dos unidades coinciden y guardar el neto crudo pasaba en verde.
  //
  // Lo que se paga por esa ceguera: la columna `order_line_separation.qty` vive
  // en el eje ORDENADO y todo lector le resta lo despachado, pero el modal
  // muestra y manda unidades DE ESTANTE. Guardar el neto sin convertir le comía
  // a la línea exactamente `fulfilled` unidades en cada Save — en producción
  // S11320 quedó clavada mostrando 7 cada vez que el operador escribía 8, y la
  // orden 3021 llegó a mostrar 0 con 122 unidades apartadas en el estante.
  //
  // El despacho se FABRICA acá (no se busca uno en el sandbox) para que la
  // sección corra siempre: un caso que a veces se saltea es un caso que no
  // cubre nada. Las tres filas se borran al final.
  console.log("\n3c. Round-trip con entrega parcial (neto ↔ bruto)");
  const FUL_ID = "ful_e2e_sep_roundtrip";
  const FULITEM_ID = "fulit_e2e_sep_roundtrip";
  const ORDFUL_ID = "ordful_e2e_sep_roundtrip";
  const locId = (
    await db.query(
      `SELECT location_id FROM inventory_level
        WHERE inventory_item_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [f.item_id]
    )
  ).rows[0]?.location_id;

  if (!locId) {
    console.log("  (sin inventory_level para el item fixture — sección salteada)");
  } else {
    await db.query(
      `INSERT INTO fulfillment (id, location_id, provider_id, requires_shipping, created_at, updated_at)
       VALUES ($1, $2, 'manual_manual', true, now(), now())`,
      [FUL_ID, locId]
    );
    await db.query(
      `INSERT INTO fulfillment_item
              (id, title, sku, barcode, quantity, raw_quantity, line_item_id,
               inventory_item_id, fulfillment_id, created_at, updated_at)
       VALUES ($1, 'e2e round-trip', 'E2E-RT', '', 1,
               '{"value":"1","precision":20}'::jsonb, $2, $3, $4, now(), now())`,
      [FULITEM_ID, f.line_id, f.item_id, FUL_ID]
    );
    await db.query(
      `INSERT INTO order_fulfillment (id, order_id, fulfillment_id, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())`,
      [ORDFUL_ID, f.order_id, FUL_ID]
    );

    const readRt = async () => {
      const r = await api(token, "GET", `/admin/orders/${f.order_id}/product-status`);
      return r.json?.lines?.find((l: any) => l.line_id === f.line_id);
    };
    const withFul = await readRt();
    const openRt = Number(withFul?.open_qty ?? 0);
    check(
      "el despacho vivo baja el pendiente en 1",
      Number(withFul?.fulfilled) === 1 && openRt === Number(f.qty) - 1,
      `fulfilled ${withFul?.fulfilled}, open ${openRt}, qty ${f.qty}`
    );

    // SUBIR: se manda lo que el operador ve (unidades de estante).
    const rtSave = await api(token, "POST", `/admin/orders/${f.order_id}/separations`, {
      separations: [{ line_id: f.line_id, qty: openRt }],
    });
    check("guardar el pendiente completo responde 200", rtSave.status === 200,
      `status ${rtSave.status}`);

    const afterSave = await readRt();
    check(
      "ROUND-TRIP: lo que se guarda es lo que se relee",
      Number(afterSave?.separated) === openRt,
      `guardé ${openRt}, releí ${afterSave?.separated} — el neto se guardó como bruto`
    );
    const storedRt = Number(
      (
        await db.query(
          `SELECT qty::numeric AS qty FROM order_line_separation
            WHERE order_id = $1 AND order_line_item_id = $2`,
          [f.order_id, f.line_id]
        )
      ).rows[0]?.qty
    );
    check(
      "la COLUMNA guarda bruto (neto + despachado)",
      storedRt === openRt + 1,
      `columna ${storedRt}, esperado ${openRt + 1}`
    );

    // El badge y la cifra tienen que contar la MISMA historia: la ruta deriva
    // el estado de lo que le mandaron (neto) y el modal lo relee de la columna
    // (bruto). Con la conversión rota, la respuesta decía `full` mientras la
    // pantalla mostraba una unidad de menos — que es como lo reportó el owner.
    check(
      "el estado que devuelve la ruta coincide con lo releído",
      rtSave.json?.separation_status === "full" &&
        Number(afterSave?.separated) === openRt,
      `ruta ${rtSave.json?.separation_status}, releído ${afterSave?.separated}/${openRt}`
    );

    // BAJAR: el camino inverso también tiene que round-trippear.
    const lower = Math.max(0, openRt - 1);
    const rtDown = await api(token, "POST", `/admin/orders/${f.order_id}/separations`, {
      separations: [{ line_id: f.line_id, qty: lower }],
    });
    check("bajar responde 200", rtDown.status === 200, `status ${rtDown.status}`);
    const afterDown = await readRt();
    check(
      "ROUND-TRIP al bajar",
      Number(afterDown?.separated) === lower,
      `guardé ${lower}, releí ${afterDown?.separated}`
    );

    // Cleanup de la sección: la separación y el despacho sintético se van, así
    // la sección 4 arranca del mismo estado que si esto no hubiera corrido.
    await db.query(
      `DELETE FROM order_line_separation
        WHERE order_id = $1 AND order_line_item_id = $2`,
      [f.order_id, f.line_id]
    );
    await db.query(`DELETE FROM order_fulfillment WHERE id = $1`, [ORDFUL_ID]);
    await db.query(`DELETE FROM fulfillment_item WHERE id = $1`, [FULITEM_ID]);
    await db.query(`DELETE FROM fulfillment WHERE id = $1`, [FUL_ID]);
    const restored = await readRt();
    check(
      "cleanup 3c: el pendiente vuelve al total ordenado",
      Number(restored?.open_qty) === Number(f.qty) &&
        Number(restored?.separated) === 0,
      `open ${restored?.open_qty}/${f.qty}, separated ${restored?.separated}`
    );
  }

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

  // ── 7. Líneas SIN INVENTARIO (servicios) fuera del dominio ────────────────
  //
  // Apartar es físico. Una línea que no rastrea inventario —instalación,
  // expedite, un cargo— no tiene unidades que mover, así que no se muestra, no
  // se puede apartar, y NO CUENTA para el estado de la orden. Esto último es lo
  // que no era cosmético: `deriveSeparationStatus` sumaba su pendiente, así que
  // una orden con una instalación no podía llegar a `full` ni apartando todo lo
  // físico (S11576: 53 unidades apartables y un `Installation-On-Site` que las
  // dejaba en `partial` para siempre).
  //
  // El predicado es la AUSENCIA DE INVENTORY ITEM, no `quickbooks_is_service`:
  // ese flag es de QBXML, se mantiene a mano, y en prod cubría 36 de las 44
  // líneas no-físicas.
  console.log("\n7. Líneas sin inventario (servicios)");
  const svc = await db.query(`
    SELECT o.id AS order_id, oli.id AS line_id, oi.quantity::numeric AS qty
      FROM "order" o
      JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
      JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      LEFT JOIN product_variant_inventory_item pvii
        ON pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL
     WHERE o.deleted_at IS NULL AND o.status NOT IN ('canceled', 'archived')
       AND pvii.inventory_item_id IS NULL
       AND oi.quantity::numeric > 0
     ORDER BY o.created_at DESC
     LIMIT 1`);
  if (!svc.rows[0]) {
    console.log("  (sin líneas de servicio en el sandbox — sección salteada)");
  } else {
    const sv = svc.rows[0];
    const svcMetaBefore = (
      await db.query(`SELECT metadata FROM "order" WHERE id = $1`, [sv.order_id])
    ).rows[0].metadata;
    const svcPs = await api(token, "GET", `/admin/orders/${sv.order_id}/product-status`);
    const svcLine = (svcPs.json?.lines ?? []).find((l: any) => l.line_id === sv.line_id);
    check("la línea de servicio existe en el DTO", !!svcLine);
    check(
      "is_separable = false",
      svcLine?.is_separable === false,
      `is_separable ${svcLine?.is_separable}`
    );
    check(
      "todos sus topes en 0",
      Number(svcLine?.separable_cap) === 0 &&
        Number(svcLine?.max_separable) === 0 &&
        Number(svcLine?.invoiced_floor) === 0,
      `cap ${svcLine?.separable_cap}, max ${svcLine?.max_separable}, floor ${svcLine?.invoiced_floor}`
    );
    // `open_qty` se deja VERAZ a propósito: el modal de Product Status lo lee
    // para decir cuánto falta que llegue, y ahí un servicio pendiente es un
    // hecho. Quien no lo muestra es el modal de separación, por `is_separable`.
    check(
      "open_qty sigue siendo veraz (Product Status lo lee)",
      Number(svcLine?.open_qty) === Number(sv.qty),
      `open ${svcLine?.open_qty}, qty ${sv.qty}`
    );

    // La RUTA es la autorización: no confía en que la pantalla haya filtrado.
    const svcPost = await api(token, "POST", `/admin/orders/${sv.order_id}/separations`, {
      separations: [{ line_id: sv.line_id, qty: 1 }],
    });
    check("apartar un servicio → 409", svcPost.status === 409, `status ${svcPost.status}`);
    check(
      "el 409 nombra el motivo REAL (no 'falta inventario')",
      svcPost.json?.error === "separation_line_not_separable" &&
        (svcPost.json?.rejections ?? []).some((r: any) => r.reason === "not_separable"),
      `error ${svcPost.json?.error}`
    );
    const svcRows = (
      await db.query(
        `SELECT COUNT(*)::int AS n FROM order_line_separation
          WHERE order_id = $1 AND order_line_item_id = $2`,
        [sv.order_id, sv.line_id]
      )
    ).rows[0].n;
    check("el 409 no escribió fila", svcRows === 0, `filas ${svcRows}`);

    // NEGATIVA que protege contra el modo de falla de este mismo fix: si una
    // línea FÍSICA perdiera su `product_variant_inventory_item`, desaparecería
    // del modal en vez de mostrarse con stock 0. Una línea física SIN STOCK
    // tiene que seguir visible y separable.
    const zeroStock = await db.query(`
      SELECT oli.id AS line_id, oi.order_id
        FROM "order" o
        JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version AND oi.deleted_at IS NULL
        JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
        JOIN product_variant_inventory_item pvii
          ON pvii.variant_id = oli.variant_id AND pvii.deleted_at IS NULL
        JOIN inventory_level il
          ON il.inventory_item_id = pvii.inventory_item_id AND il.deleted_at IS NULL
         AND il.stocked_quantity <= 0
       WHERE o.deleted_at IS NULL AND o.status NOT IN ('canceled', 'archived')
         AND oi.quantity::numeric > 0
       LIMIT 1`);
    if (zeroStock.rows[0]) {
      const zs = zeroStock.rows[0];
      const zsPs = await api(token, "GET", `/admin/orders/${zs.order_id}/product-status`);
      const zsLine = (zsPs.json?.lines ?? []).find((l: any) => l.line_id === zs.line_id);
      check(
        "NEGATIVA: una línea FÍSICA sin stock sigue siendo separable",
        zsLine?.is_separable === true,
        `is_separable ${zsLine?.is_separable} — el fix estaría escondiendo trabajo real`
      );
    } else {
      console.log("  (sin líneas físicas en stock 0 — negativa no ejercitada)");
    }

    // ── La mitad que NO era cosmética ────────────────────────────────────────
    // Con el servicio adentro de la derivación, su pendiente entraba al total y
    // la orden no podía llegar a `full` ni apartando todo lo físico: el badge
    // se quedaba en `partial` para siempre. Acá se aparta TODO lo separable y
    // se exige `full` con las líneas de servicio todavía pendientes.
    const svcLines = (svcPs.json?.lines ?? []) as any[];
    const svcOpenUnits = svcLines
      .filter((l) => l.is_separable === false)
      .reduce((acc, l) => acc + Number(l.open_qty), 0);
    const toSeparate = svcLines
      .filter((l) => l.is_separable !== false && Number(l.open_qty) > 0)
      .map((l) => ({ line_id: l.line_id, qty: Number(l.max_separable) }));
    const allBackedSvc = svcLines
      .filter((l) => l.is_separable !== false)
      .every((l) => Number(l.max_separable) >= Number(l.open_qty));

    if (toSeparate.length && svcOpenUnits > 0 && allBackedSvc) {
      const svcFull = await api(token, "POST", `/admin/orders/${sv.order_id}/separations`, {
        separations: toSeparate,
      });
      check(
        `una orden con ${svcOpenUnits} unidades de servicio pendientes llega a FULL`,
        svcFull.status === 200 && svcFull.json?.separation_status === "full",
        `status ${svcFull.status}, separation_status ${svcFull.json?.separation_status} — el servicio está contando para el estado`
      );
      // Y el LECTOR tiene que decir lo mismo que el escritor: son dos llamadas
      // distintas a la misma derivación, y si sólo una filtrara, la pantalla y
      // el badge de la lista se contradirían.
      const svcRead = await api(token, "GET", `/admin/orders/${sv.order_id}/product-status`);
      check(
        "el GET lee el MISMO estado que devolvió el POST",
        svcRead.json?.order?.separation_status === "full",
        `GET ${svcRead.json?.order?.separation_status}, POST ${svcFull.json?.separation_status}`
      );

    } else {
      console.log(
        "  (la orden de servicio no tiene todas sus líneas respaldadas — full no es alcanzable, caso no ejercitado)"
      );
    }

    // Cleanup INCONDICIONAL. Vivía adentro del `if` de arriba y eso era un bug
    // del test, no del código: al saltearse esa rama la fila que escribió el
    // POST del 409 sobrevivía a la corrida y envenenaba la siguiente (un
    // mutation test lo destapó — "el 409 no escribió fila: filas 1" salió rojo
    // por basura de la corrida ANTERIOR). Un E2E que sólo limpia en su camino
    // feliz miente exactamente cuando algo salió mal, que es cuando se lo lee.
    await db.query(`DELETE FROM order_line_separation WHERE order_id = $1`, [
      sv.order_id,
    ]);
    await db.query(`UPDATE "order" SET metadata = $2::jsonb WHERE id = $1`, [
      sv.order_id,
      JSON.stringify(svcMetaBefore ?? {}),
    ]);
    await db.query(
      `DELETE FROM order_change
        WHERE order_id = $1 AND change_type = 'pos_activity'
          AND internal_note LIKE '__pos_activity__%separation_saved%'`,
      [sv.order_id]
    );
    const svcClean = (
      await db.query(
        `SELECT COUNT(*)::int AS n FROM order_line_separation WHERE order_id = $1`,
        [sv.order_id]
      )
    ).rows[0].n;
    check("cleanup 7: la orden de servicio queda como estaba", svcClean === 0,
      `quedaron ${svcClean} filas`);
  }

  // ── Cleanup: volver el sandbox a como estaba ───────────────────────────────
  await db.query(
    `DELETE FROM order_line_separation WHERE order_id = $1`,
    [f.order_id]
  );
  await db.query(`UPDATE "order" SET metadata = $2::jsonb WHERE id = $1`, [
    f.order_id,
    JSON.stringify(metaBefore ?? {}),
  ]);
  await db.query(
    `DELETE FROM order_change
      WHERE order_id = $1 AND change_type = 'pos_activity'
        AND internal_note LIKE '__pos_activity__%separation_saved%'`,
    [f.order_id]
  );
  console.log("\nCleanup: filas borradas y metadata restaurado");

  await db.end();
  console.log(`\n${pass}/${pass + fail} PASS`);
  if (fail) process.exit(1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
