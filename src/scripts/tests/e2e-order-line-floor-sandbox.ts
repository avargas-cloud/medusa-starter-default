/**
 * E2E del piso de una línea de orden, contra las RUTAS del sandbox.
 *
 * EL AGUJERO QUE CIERRA
 *   Hasta el 2026-09-05 `delete-item-force` de orders borraba la línea EN DURO
 *   y soltaba sus reservas mirando sólo si la orden estaba `archived`, y el
 *   botón de borrar de `LineItemsTable` estaba SIEMPRE visible. O sea que por
 *   la pantalla normal —no por el sync de BOM— un cajero podía sacar de la
 *   orden una línea ya facturada, y la factura quedaba apuntando a una línea
 *   inexistente. Medido en producción ese día: 5.339 de 5.575 líneas vivas
 *   (96%) tienen unidades facturadas o entregadas.
 *
 * POR QUÉ CONTRA LA RUTA Y NO CONTRA EL HELPER
 *   `verify-order-line-floor` ya afirma el predicado y la paridad con
 *   separación. Lo que no puede ver es si la ruta lo LLAMA de verdad y si el
 *   efecto ocurre: un 409 no prueba nada por sí solo —una conexión rota
 *   también da 409—, así que cada rechazo se confirma releyendo la base, y
 *   cada permiso se confirma comprobando que el número cambió.
 *
 * CORRER (nunca contra prod — aborta si el destino no es local):
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     npx medusa exec ./src/scripts/tests/e2e-order-line-floor-sandbox.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";

const API = process.env.MEDUSA_SANDBOX_URL ?? "http://localhost:9099";
const ADMIN_EMAIL = process.env.SANDBOX_ADMIN_EMAIL ?? "sandbox@test.com";
const ADMIN_PASS = process.env.SANDBOX_ADMIN_PASSWORD ?? "sandbox123";

type Check = { name: string; ok: boolean; detail?: string };

export default async function e2eOrderLineFloor({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const pool = getDbPool();
  const checks: Check[] = [];
  const ok = (name: string, cond: boolean, detail?: string) =>
    checks.push({ name, ok: cond, detail });

  // Un typo en la URL no puede terminar editando órdenes de producción.
  const host = new URL(API).hostname;
  if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    throw new Error(`[e2e-order-line-floor] destino NO local: ${API} — abortado`);
  }

  const auth = await fetch(`${API}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  const token = ((await auth.json()) as { token?: string }).token;
  if (!token) throw new Error("[e2e-order-line-floor] login falló");

  const call = async (path: string, body: unknown) => {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await r.json()) as Record<string, unknown>;
    } catch {
      /* respuesta sin cuerpo */
    }
    return { status: r.status, body: parsed };
  };

  const qty = async (lineId: string): Promise<number | null> => {
    const r = await pool.query<{ q: string }>(
      `SELECT oi.quantity::text AS q
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
        WHERE oi.item_id = $1`,
      [lineId]
    );
    return r.rows.length ? Number(r.rows[0].q) : null;
  };
  const exists = async (lineId: string): Promise<boolean> => {
    const r = await pool.query(
      `SELECT 1 FROM order_line_item WHERE id = $1 AND deleted_at IS NULL`,
      [lineId]
    );
    return r.rowCount === 1;
  };

  // ── Fixture: una línea CON piso, en una orden editable ────────────────────
  const withFloor = await pool.query<{
    order_id: string;
    line_id: string;
    quantity: string;
    floor: string;
  }>(
    `SELECT oi.order_id, oli.id AS line_id, oi.quantity::text AS quantity,
            COALESCE((SELECT SUM(pii.quantity) FROM pos_invoice_item pii
                        JOIN pos_invoice pi ON pi.id = pii.invoice_id
                       WHERE pii.order_line_item_id = oli.id
                         AND pi.deleted_at IS NULL
                         AND pi.status NOT IN ('draft','voided')), 0)::text AS floor
       FROM order_item oi
       JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
       JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
      WHERE o.is_draft_order = false
        AND o.status = 'pending'
        AND COALESCE((SELECT SUM(pii.quantity) FROM pos_invoice_item pii
                        JOIN pos_invoice pi ON pi.id = pii.invoice_id
                       WHERE pii.order_line_item_id = oli.id
                         AND pi.deleted_at IS NULL
                         AND pi.status NOT IN ('draft','voided')), 0) > 0
      LIMIT 1`
  );
  if (!withFloor.rowCount) {
    throw new Error(
      "[e2e-order-line-floor] no hay ninguna línea facturada en una orden 'pending' del sandbox — " +
        "sin fixture este suite no prueba nada; restaurá el sandbox antes de creerle"
    );
  }
  const f = withFloor.rows[0];
  const floor = Number(f.floor);
  const startQty = Number(f.quantity);
  logger.info(
    `[e2e-order-line-floor] fixture con piso: línea ${f.line_id} qty=${startQty} piso=${floor}`
  );

  // 1 · borrar una línea facturada se RECHAZA — y sigue viva
  {
    const r = await call(`/admin/orders/${f.order_id}/delete-item-force`, {
      line_item_id: f.line_id,
    });
    ok("1 · borrar una línea facturada devuelve 409", r.status === 409, `status=${r.status}`);
    ok(
      "1 · el rechazo se identifica por código, no por texto",
      r.body?.code === "BELOW_INVOICED_FLOOR",
      String(r.body?.code)
    );
    ok("1 · y la línea SIGUE VIVA en la base", await exists(f.line_id));
  }

  // 2 · bajar por debajo del piso se RECHAZA — y la cantidad no se movió
  {
    const target = Math.max(0, floor - 1);
    const r = await call(`/admin/orders/${f.order_id}/update-item-force`, {
      line_item_id: f.line_id,
      quantity: target,
    });
    ok(`2 · bajar a ${target} (piso ${floor}) devuelve 409`, r.status === 409, `status=${r.status}`);
    ok("2 · la cantidad NO cambió en la base", (await qty(f.line_id)) === startQty);
  }

  // 3 · bajar EXACTAMENTE al piso se PERMITE — y el efecto ocurre
  //     Este es el control positivo: sin él, los rechazos de arriba los pasaría
  //     igual un guard que rechace TODO.
  {
    const r = await call(`/admin/orders/${f.order_id}/update-item-force`, {
      line_item_id: f.line_id,
      quantity: floor,
    });
    ok(`3 · bajar al piso exacto (${floor}) se permite`, r.status === 200, `status=${r.status}`);
    ok("3 · y la base quedó en el piso", (await qty(f.line_id)) === floor);
  }

  // 4 · subir por encima se PERMITE
  {
    const target = floor + 3;
    const r = await call(`/admin/orders/${f.order_id}/update-item-force`, {
      line_item_id: f.line_id,
      quantity: target,
    });
    ok(`4 · subir a ${target} se permite`, r.status === 200, `status=${r.status}`);
    ok("4 · y la base subió", (await qty(f.line_id)) === target);
  }

  // 5 · una edición que NO toca la cantidad nunca se bloquea
  //     Aserción NEGATIVA obligatoria: el 96% de las líneas tiene piso, así que
  //     un guard que muerda de más se come el trabajo diario de la caja.
  {
    const r = await call(`/admin/orders/${f.order_id}/update-item-force`, {
      line_item_id: f.line_id,
      custom_title: `E2E floor ${Date.now()}`,
    });
    ok("5 · cambiar el título de una línea con piso se permite", r.status === 200, `status=${r.status}`);
    const r2 = await call(`/admin/orders/${f.order_id}/update-item-force`, {
      line_item_id: f.line_id,
      unit_price: 12.34,
    });
    ok("5 · cambiar el precio de una línea con piso se permite", r2.status === 200, `status=${r2.status}`);
  }

  // devolver la línea a su cantidad original
  await call(`/admin/orders/${f.order_id}/update-item-force`, {
    line_item_id: f.line_id,
    quantity: startQty,
  });
  ok("6 · fixture restaurado a su cantidad inicial", (await qty(f.line_id)) === startQty);

  // 6b · LA RUTA GEMELA no es una puerta de atrás
  //
  // El P0 del 2026-09-05: `draft-orders/[id]/{delete,update}-item-force` son
  // copias divergidas de las de `orders/`, en otro prefijo de path, y no leían
  // `req.params.id` ni `is_draft_order`. Reproducido: la MISMA línea facturada
  // daba 409 por `orders/` y 200 por `draft-orders/`, y quedaba borrada.
  {
    const r = await call(`/admin/draft-orders/${f.order_id}/delete-item-force`, {
      line_item_id: f.line_id,
    });
    ok("6b · borrar por la ruta GEMELA también devuelve 409", r.status === 409, `status=${r.status}`);
    ok("6b · y la línea sigue viva", await exists(f.line_id));

    const r2 = await call(`/admin/draft-orders/${f.order_id}/update-item-force`, {
      line_item_id: f.line_id,
      quantity: Math.max(0, floor - 1),
    });
    ok("6b · bajar por la GEMELA también devuelve 409", r2.status === 409, `status=${r2.status}`);
    ok("6b · la cantidad no se movió", (await qty(f.line_id)) === startQty);
  }

  // 6c · el `:id` del path significa algo: una línea de OTRA orden se rechaza
  {
    const other = await pool.query<{ line_id: string }>(
      `SELECT oli.id AS line_id
         FROM order_item oi
         JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
        WHERE oi.order_id <> $1
        LIMIT 1`,
      [f.order_id]
    );
    if (other.rowCount) {
      const foreign = other.rows[0].line_id;
      const r = await call(`/admin/draft-orders/${f.order_id}/delete-item-force`, {
        line_item_id: foreign,
      });
      ok("6c · una línea de OTRA orden se rechaza", r.status === 409, `status=${r.status}`);
      ok("6c · con su propio código", r.body?.code === "LINE_NOT_IN_ORDER", String(r.body?.code));
      ok("6c · y sigue viva", await exists(foreign));
    } else {
      ok("6c · [SIN FIXTURE] no hay línea de otra orden", false, "sandbox sin datos");
    }
  }

  // 7 · una línea SIN piso sí se puede borrar — el otro control positivo
  //
  // El test CREA la línea que va a borrar, en vez de elegir una del sandbox.
  // La versión anterior se comía una línea limpia de una orden real en CADA
  // corrida y no la reponía: un test que degrada su propio fixture se queda sin
  // fixture, y este repo ya pagó eso (los 4 scripts de BL que murieron juntos
  // cuando un refresh se llevó el proyecto que compartían).
  {
    const variant = await pool.query<{ variant_id: string }>(
      `SELECT oli.variant_id
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
         JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
        WHERE oi.order_id = $1 AND oli.variant_id IS NOT NULL
        LIMIT 1`,
      [f.order_id]
    );
    if (!variant.rowCount) {
      ok("7 · [SIN FIXTURE] la orden no tiene ninguna línea con variante", false, "");
    } else {
      const before = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM order_item oi
           JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
           JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
          WHERE oi.order_id = $1`,
        [f.order_id]
      );
      const add = await call(`/admin/orders/${f.order_id}/add-item-force`, {
        variant_id: variant.rows[0].variant_id,
        quantity: 1,
        unit_price: 1,
        custom_title: `E2E floor disposable ${Date.now()}`,
      });
      ok("7 · se puede agregar una línea desechable", add.status === 200, `status=${add.status}`);

      const fresh = await pool.query<{ line_id: string }>(
        `SELECT oli.id AS line_id
           FROM order_item oi
           JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
           JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
          WHERE oi.order_id = $1 AND oli.title LIKE 'E2E floor disposable%'
          ORDER BY oli.created_at DESC
          LIMIT 1`,
        [f.order_id]
      );
      if (!fresh.rowCount) {
        ok("7 · la línea desechable existe tras agregarla", false, "no se encontró");
      } else {
        const disposable = fresh.rows[0].line_id;
        const r = await call(`/admin/orders/${f.order_id}/delete-item-force`, {
          line_item_id: disposable,
        });
        ok("7 · borrar una línea SIN piso se permite", r.status === 200, `status=${r.status}`);
        ok("7 · y la línea desapareció de la base", !(await exists(disposable)));

        const after = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM order_item oi
             JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
             JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
            WHERE oi.order_id = $1`,
          [f.order_id]
        );
        // El check que impide que este suite vuelva a comerse el fixture.
        ok(
          "7 · la orden quedó con las MISMAS líneas que antes (no se consumió fixture)",
          after.rows[0].n === before.rows[0].n,
          `antes=${before.rows[0].n} después=${after.rows[0].n}`
        );
      }
    }
  }

  // El fixture vuelve a su cantidad inicial pase lo que pase — una excepción a
  // mitad de camino dejaba la línea con la cantidad del último paso.
  try {
    await call(`/admin/orders/${f.order_id}/update-item-force`, {
      line_item_id: f.line_id,
      quantity: startQty,
    });
  } catch {
    /* el reporte de abajo ya dice si quedó mal */
  }

  const bad = checks.filter((c) => !c.ok);
  console.log(`${bad.length ? "FAIL" : "PASS"}  piso de línea de orden`);
  for (const c of checks) {
    console.log(`      ${c.ok ? "ok " : "NO "} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`\n${checks.length - bad.length}/${checks.length} passed\n`);
  if (bad.length) {
    throw new Error(`[e2e-order-line-floor] ${bad.length} check(s) FALLARON`);
  }
}
