/**
 * E2E — tracking por línea en un Purchase Order — SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * `verify-po-tracking-allocations.ts` es estático: mira el estado guardado y
 * comprueba que ninguna invariante esté rota AHORA. No puede probar el EFECTO,
 * que es lo único que el comprador va a mirar: que dos cajas del mismo PO se
 * repartan la mercadería sin pisarse, y que el sistema le impida romperlo.
 *
 * Y hay una forma de fallar que ningún gate estático ve. El cap vive en el
 * servicio, dentro de una transacción con lock — si esa transacción quedara mal
 * cableada, el cap rechazaría SIEMPRE (o no rechazaría NUNCA) y todo seguiría
 * en verde. Por eso un 409 con una cantidad excesiva no prueba nada por sí solo:
 * lo que prueba es que la cantidad CORRECTA sea ACEPTADA y que el efecto ocurra.
 *
 * ── Qué cubre ─────────────────────────────────────────────────────────────────
 *  0. CONTROL POSITIVO: la línea elegida tiene su remanente COMPLETO antes de
 *     empezar. Sin esto, un "quedan 0" al final podría ser un endpoint que
 *     devuelve ceros.
 *  1. Con un ALL ORDER vivo, agregar una caja POR ÍTEM es RECHAZADA (409
 *     `tracking_scope_conflict`) — el genérico ya reclama todo el PO, así que
 *     no hay nada que darle a una segunda caja. La salida es editar el genérico.
 *  1b. Editar ESE ALL ORDER marcando lo que realmente llegó lo convierte en
 *     por-ítem y libera el resto. Así es como un PO se parte: corrigiendo la
 *     primera caja, nunca agregando otra al lado.
 *  2. Caja A por ítem (parte de la línea) → aceptada; el remanente baja exacto.
 *  3. Pedir MÁS que el remanente → 409 nombrando dónde están las unidades que
 *     faltan, y NO se crea ninguna caja.
 *  4. Caja B con el remanente exacto → aceptada (el cap deja pasar lo correcto).
 *  5. Editar la caja A se ve a sí misma: su remanente la incluye, así que puede
 *     volver a guardar lo que ya tiene sin que el cap la rechace.
 *  6. Bajar o borrar la línea del PO mientras hay unidades en camino → 409
 *     nombrando la guía; y una línea SIN envío sí se puede bajar (control).
 *  7. Borrar una caja libera su cantidad y se lleva sus allocations.
 *  8. `expected_at` del PO NO cambió en todo el ejercicio — el ETA por línea se
 *     deriva en paralelo y la cabecera conserva su política.
 *
 * QuickBooks NO se toca: el tracking de entrada nunca sincronizó a QB.
 *
 *   ./back-sb   # backend sandbox en :9099
 *   env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     npx medusa exec ./src/scripts/tests/e2e-po-tracking-allocations-sandbox.ts
 */

const BASE = process.env.SANDBOX_URL ?? "http://localhost:9099";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    process.stdout.write(`  PASS  ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL  ${name}\n          ${detail}\n`);
  }
}

function abort(why: string): never {
  process.stdout.write(`\nABORTED: ${why}\n`);
  process.exit(1);
}

interface Resp<T> {
  status: number;
  body: T;
}

async function call<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; pin?: string } = {}
): Promise<Resp<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (init.pin) headers["x-supervisor-pin"] = init.pin;
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body: body as T };
}

interface TrackingLineView {
  purchase_order_line_id: string;
  sku_snapshot: string;
  qty_ordered: number;
  qty_allocated_elsewhere: number;
  qty_remaining: number;
}

interface TrackingNumberView {
  id: string;
  tracking_number: string;
  is_master: boolean;
}

interface TrackingView {
  id: string;
  scope: string;
  numbers: TrackingNumberView[];
  master: TrackingNumberView | null;
  lines: Array<{ purchase_order_line_id: string; qty: number }>;
}

interface TrackingPayload {
  tracking: TrackingView[];
  coverage: string;
  lines?: TrackingLineView[];
  code?: string;
  rejections?: Array<{ message: string; max: number }>;
}

async function login(): Promise<string> {
  const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
  const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
  const res = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json()) as { token?: string };
  if (!body.token) abort("no se pudo autenticar contra el sandbox");
  return body.token;
}

/**
 * Un PO submitted, con una línea de al menos 4 unidades y SIN NINGÚN tracking.
 *
 * "Sin ninguno" es deliberado, no comodidad. Los dos modos no conviven, así que
 * un PO que ya arrastra guías legacy `all_order` bloquearía —correctamente— la
 * conversión que este test ejerce, y el rojo diría "el escenario no aplica"
 * cuando el código está bien. El escenario empieza en limpio y crea su propia
 * primera caja.
 */
async function pickPo(
  db: Knex
): Promise<{ poId: string; lineId: string; ordered: number }> {
  const res = await db.raw(
    `SELECT pol.purchase_order_id AS po_id, pol.id AS line_id,
            GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0)::int AS ordered
       FROM purchase_order_line pol
       JOIN purchase_order po ON po.id = pol.purchase_order_id AND po.deleted_at IS NULL
      WHERE pol.deleted_at IS NULL
        AND po.status = 'submitted'
        AND COALESCE(pol.status,'open') <> 'cancelled'
        AND GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0) >= 4
        AND NOT EXISTS (
              SELECT 1 FROM purchase_order_tracking trk
               WHERE trk.purchase_order_id = po.id
                 AND trk.deleted_at IS NULL)
        -- Una SEGUNDA línea con cantidad, para que el control positivo del
        -- guard del PATCH (6c) tenga sobre qué correr.
        AND EXISTS (
              SELECT 1 FROM purchase_order_line other
               WHERE other.purchase_order_id = po.id
                 AND other.id <> pol.id
                 AND other.deleted_at IS NULL
                 AND COALESCE(other.status,'open') <> 'cancelled'
                 AND other.qty_ordered > 1)
      ORDER BY pol.purchase_order_id, pol.line_order
      LIMIT 1`
  );
  const row = res.rows[0] as
    | { po_id: string; line_id: string; ordered: number }
    | undefined;
  if (!row)
    abort(
      "no hay ningún PO submitted SIN tracking con una línea de >= 4 unidades"
    );
  return {
    poId: row.po_id,
    lineId: row.line_id,
    ordered: Number(row.ordered),
  };
}

async function supervisorPin(db: Knex): Promise<string | undefined> {
  const res = await db.raw(
    `SELECT metadata->>'pos_supervisor_pin' AS pin FROM store LIMIT 1`
  );
  const pin = (res.rows[0] as { pin?: string } | undefined)?.pin;
  return pin || undefined;
}

/** A shipment identified by the number it is known by. */
function byNumber(
  payload: TrackingPayload,
  num: string
): TrackingView | undefined {
  return payload.tracking?.find((t) =>
    (t.numbers ?? []).some((n) => n.tracking_number === num)
  );
}

function lineOf(
  payload: TrackingPayload,
  lineId: string
): TrackingLineView | undefined {
  return payload.lines?.find((l) => l.purchase_order_line_id === lineId);
}

export default async function run({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}): Promise<void> {
  const db = container.resolve("__pg_connection__") as Knex;

  if (!BASE.includes("localhost") && !BASE.includes("127.0.0.1")) {
    abort(`SANDBOX_URL apunta fuera de localhost (${BASE}) — abortado`);
  }

  const token = await login();
  const { poId, lineId, ordered } = await pickPo(db);
  const pin = await supervisorPin(db);
  const api = `/admin/purchase-orders/${poId}/tracking`;

  process.stdout.write(
    `\nPO ${poId}\nlínea ${lineId} · ordenadas ${ordered}\n\n`
  );

  const createdTrackingIds: string[] = [];
  const expectedBefore = (
    (await db.raw(`SELECT expected_at FROM purchase_order WHERE id = ?`, [poId]))
      .rows[0] as { expected_at: Date | null }
  ).expected_at;

  try {
    // ── 0. Control positivo ──────────────────────────────────────────────────
    const base = await call<TrackingPayload>(token, api);
    const baseLine = lineOf(base.body, lineId);
    check(
      "0. control positivo: la línea arranca con su remanente completo",
      baseLine?.qty_remaining === ordered,
      `remaining=${baseLine?.qty_remaining} esperado=${ordered}`
    );

    // ── 1. Los dos modos NO conviven ─────────────────────────────────────────
    const allOrder = await call<TrackingPayload>(token, api, {
      method: "POST",
      body: { provider: "UPS", tracking_number: "1ZE2E_BOXA" },
    });
    const boxAId = byNumber(allOrder.body, "1ZE2E_BOXA")?.id;
    if (boxAId) createdTrackingIds.push(boxAId);

    const half = Math.floor(ordered / 2);
    const rest = ordered - half;

    const sideBySide = await call<TrackingPayload>(token, api, {
      method: "POST",
      body: {
        provider: "FedEx",
        tracking_number: "1ZE2E_SIDEBYSIDE",
        lines: [{ purchase_order_line_id: lineId, qty: half }],
      },
    });
    const sideCreated = (
      await db.raw(
        `SELECT count(*)::int AS n FROM purchase_order_tracking_number
          WHERE tracking_number = '1ZE2E_SIDEBYSIDE' AND deleted_at IS NULL`
      )
    ).rows[0] as { n: number };
    check(
      "1. con un ALL ORDER vivo, agregar por ítem al lado es RECHAZADO",
      sideBySide.status === 409 &&
        sideBySide.body.code === "tracking_scope_conflict" &&
        Number(sideCreated.n) === 0,
      `status=${sideBySide.status} code=${sideBySide.body.code} filas=${sideCreated.n}`
    );

    // ── 1a. Otra GUÍA para el MISMO envío sí se permite ──────────────────────
    // Dos waybills del mismo camión no son dos entregas: son dos etiquetas de
    // una. Es la distinción que justifica que los números vivan aparte.
    const secondNumber = await call<TrackingPayload>(token, api, {
      method: "POST",
      body: {
        provider: "UPS",
        tracking_number: "1ZE2E_BOXA_2",
        shipment_id: boxAId,
      },
    });
    const withTwo = byNumber(secondNumber.body, "1ZE2E_BOXA_2");
    check(
      "1a. una segunda GUÍA para el mismo envío es aceptada",
      secondNumber.status === 201 &&
        withTwo?.id === boxAId &&
        (withTwo?.numbers ?? []).length === 2,
      `status=${secondNumber.status} mismo_envio=${withTwo?.id === boxAId} guias=${(withTwo?.numbers ?? []).length}`
    );
    check(
      "1a2. la primera guía sigue siendo el master",
      withTwo?.master?.tracking_number === "1ZE2E_BOXA",
      `master=${withTwo?.master?.tracking_number}`
    );

    // ── 1b. Editar el ALL ORDER es la salida ─────────────────────────────────
    const converted = await call<TrackingPayload>(token, api, {
      method: "PUT",
      body: {
        shipment_id: boxAId,
        lines: [{ purchase_order_line_id: lineId, qty: half }],
      },
    });
    check(
      "1b. editar el ALL ORDER marcando lo que llegó lo convierte a por-ítem",
      converted.status === 200 &&
        converted.body.tracking.find((t) => t.id === boxAId)?.scope === "by_line",
      `status=${converted.status} scope=${converted.body.tracking.find((t) => t.id === boxAId)?.scope}`
    );

    // ── 2. Y libera el resto ─────────────────────────────────────────────────
    const afterA = await call<TrackingPayload>(token, api);
    check(
      `2. convertir la caja A (${half} de ${ordered}) libera el remanente exacto`,
      lineOf(afterA.body, lineId)?.qty_remaining === rest,
      `remaining=${lineOf(afterA.body, lineId)?.qty_remaining} esperado=${rest}`
    );

    // ── 3. Exceder el cap ────────────────────────────────────────────────────
    const over = await call<TrackingPayload>(token, api, {
      method: "POST",
      body: {
        provider: "UPS",
        tracking_number: "1ZE2E_OVER",
        lines: [{ purchase_order_line_id: lineId, qty: rest + 1 }],
      },
    });
    const overCreated = (
      await db.raw(
        `SELECT count(*)::int AS n FROM purchase_order_tracking_number
          WHERE tracking_number = '1ZE2E_OVER' AND deleted_at IS NULL`
      )
    ).rows[0] as { n: number };
    check(
      `3. pedir ${rest + 1} con ${rest} libres → 409 y NO se crea la caja`,
      over.status === 409 &&
        over.body.code === "allocation_exceeds_remaining" &&
        Number(overCreated.n) === 0,
      `status=${over.status} code=${over.body.code} filas=${overCreated.n}`
    );
    check(
      "3b. el 409 dice dónde están las unidades que faltan",
      Boolean(over.body.rejections?.[0]?.message?.includes("1ZE2E_BOXA")),
      `mensaje="${over.body.rejections?.[0]?.message ?? ""}"`
    );

    // ── 4. Caja B con el remanente exacto ────────────────────────────────────
    const boxB = await call<TrackingPayload>(token, api, {
      method: "POST",
      body: {
        provider: "FedEx",
        tracking_number: "770000E2EB",
        lines: [{ purchase_order_line_id: lineId, qty: rest }],
      },
    });
    const boxBId = byNumber(boxB.body, "770000E2EB")?.id;
    if (boxBId) createdTrackingIds.push(boxBId);
    const afterB = await call<TrackingPayload>(token, api);
    check(
      `4. caja B con el remanente exacto (${rest}) es ACEPTADA`,
      boxB.status === 201 && lineOf(afterB.body, lineId)?.qty_remaining === 0,
      `status=${boxB.status} remaining=${lineOf(afterB.body, lineId)?.qty_remaining}`
    );

    // ── 5. El editor se ve a sí mismo ────────────────────────────────────────
    const editView = await call<TrackingPayload>(
      token,
      `${api}?shipment_id=${boxAId}`
    );
    check(
      `5. editando la caja A su remanente la incluye (${half}, no 0)`,
      lineOf(editView.body, lineId)?.qty_remaining === half,
      `remaining=${lineOf(editView.body, lineId)?.qty_remaining} esperado=${half}`
    );
    const resave = await call<TrackingPayload>(token, api, {
      method: "PUT",
      body: {
        shipment_id: boxAId,
        lines: [{ purchase_order_line_id: lineId, qty: half }],
      },
    });
    check(
      "5b. re-guardar la caja A con lo que ya tiene NO es rechazado",
      resave.status === 200,
      `status=${resave.status} code=${resave.body.code}`
    );

    // ── 6. El PATCH del PO no puede dejar un envío colgado ───────────────────
    const detail = await call<{
      purchase_order: {
        lines: Array<Record<string, unknown>>;
        expected_at: string | null;
      };
    }>(token, `/admin/purchase-orders/${poId}`);
    const poLines = detail.body.purchase_order.lines;
    const payloadLines = (transform: (r: Record<string, unknown>) => Record<string, unknown> | null) =>
      poLines
        .map((l) =>
          transform({
            id: l.id,
            product_variant_id: l.product_variant_id,
            inventory_item_id: l.inventory_item_id,
            sku_snapshot: l.sku_snapshot,
            description_snapshot: l.description_snapshot,
            qty_ordered: l.qty_ordered,
            unit_cost_cents: l.unit_cost_cents,
            line_order: l.line_order ?? 0,
          })
        )
        .filter((r): r is Record<string, unknown> => r !== null);

    const shrink = await call<{ code?: string; rejections?: Array<{ message: string }> }>(
      token,
      `/admin/purchase-orders/${poId}`,
      {
        method: "PATCH",
        pin,
        body: {
          lines: payloadLines((r) =>
            r.id === lineId ? { ...r, qty_ordered: 1 } : r
          ),
        },
      }
    );
    check(
      "6. bajar la línea con unidades en camino → 409 nombrando la guía",
      shrink.status === 409 &&
        shrink.body.code === "line_claimed_by_tracking" &&
        Boolean(shrink.body.rejections?.[0]?.message?.includes("1ZE2E_BOXA")),
      `status=${shrink.status} code=${shrink.body.code} msg="${shrink.body.rejections?.[0]?.message ?? ""}"`
    );

    const drop = await call<{ code?: string }>(
      token,
      `/admin/purchase-orders/${poId}`,
      {
        method: "PATCH",
        pin,
        body: { lines: payloadLines((r) => (r.id === lineId ? null : r)) },
      }
    );
    check(
      "6b. borrar esa línea → 409 (no cascade mudo)",
      drop.status === 409 && drop.body.code === "line_claimed_by_tracking",
      `status=${drop.status} code=${drop.body.code}`
    );

    // Control: una línea SIN envío sí se puede tocar. Sin esto, los dos 409 de
    // arriba serían igual de compatibles con "el PATCH está roto".
    const otherLine = poLines.find(
      (l) => l.id !== lineId && Number(l.qty_ordered) > 1
    );
    if (!otherLine) {
      // Un control que no corrió NO es un control que pasó. Si este PO no tiene
      // otra línea con cantidad, los dos 409 de arriba quedan sin contraparte y
      // serían igual de compatibles con "el PATCH está roto" — hay que decirlo.
      failed++;
      process.stdout.write(
        "  FAIL  6c. CONTROL NO EJECUTADO: este PO no tiene otra línea con qty > 1,\n" +
          "          así que los 409 de 6 y 6b quedaron sin control positivo.\n"
      );
    }
    if (otherLine) {
      const ok = await call<{ code?: string }>(
        token,
        `/admin/purchase-orders/${poId}`,
        {
          method: "PATCH",
          pin,
          body: {
            lines: payloadLines((r) =>
              r.id === otherLine.id
                ? { ...r, qty_ordered: Number(otherLine.qty_ordered) }
                : r
            ),
          },
        }
      );
      check(
        "6c. CONTROL: una línea sin envío sigue siendo editable",
        ok.status === 200,
        `status=${ok.status} code=${ok.body.code}`
      );
    }

    // ── 7. Borrar una caja libera ────────────────────────────────────────────
    await call(token, api, {
      method: "DELETE",
      body: { shipment_id: boxAId },
    });
    const afterDelete = await call<TrackingPayload>(token, api);
    const orphans = (
      await db.raw(
        `SELECT count(*)::int AS n FROM purchase_order_tracking_line
          WHERE purchase_order_tracking_id = ?`,
        [boxAId]
      )
    ).rows[0] as { n: number };
    check(
      `7. borrar la caja A libera sus ${half} unidades`,
      lineOf(afterDelete.body, lineId)?.qty_remaining === half,
      `remaining=${lineOf(afterDelete.body, lineId)?.qty_remaining} esperado=${half}`
    );
    check(
      "7b. sus allocations se fueron con ella (CASCADE)",
      Number(orphans.n) === 0,
      `quedaron ${orphans.n} filas`
    );

    // ── 8. La cabecera no se movió ───────────────────────────────────────────
    const expectedAfter = (
      (await db.raw(`SELECT expected_at FROM purchase_order WHERE id = ?`, [poId]))
        .rows[0] as { expected_at: Date | null }
    ).expected_at;
    const same =
      (expectedBefore === null && expectedAfter === null) ||
      String(expectedBefore) === String(expectedAfter);
    check(
      "8. expected_at del PO NO cambió (la cabecera conserva su política)",
      same,
      `antes=${String(expectedBefore)} después=${String(expectedAfter)}`
    );
  } finally {
    // Limpieza: las cajas del test se van; las allocations caen por CASCADE.
    if (createdTrackingIds.length > 0) {
      await db.raw(
        `DELETE FROM purchase_order_tracking WHERE id = ANY(?)`,
        [createdTrackingIds]
      );
    }
    await db.raw(
      `DELETE FROM purchase_order_tracking trk
        USING purchase_order_tracking_number n
        WHERE n.purchase_order_tracking_id = trk.id
          AND n.tracking_number IN
              ('1ZE2E_BOXA','1ZE2E_BOXA_2','770000E2EB','1ZE2E_OVER','1ZE2E_SIDEBYSIDE')`
    );
  }

  process.stdout.write(
    `\n${passed}/${passed + failed} checks OK${failed > 0 ? ` — ${failed} FALLARON` : ""}\n\n`
  );
  if (failed > 0) process.exitCode = 1;
}
