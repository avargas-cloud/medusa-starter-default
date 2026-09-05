/**
 * Gate del piso de una línea de orden (2026-09-05).
 *
 * Regla del operador: una línea sólo se puede reducir si la nueva cantidad es
 * MAYOR O IGUAL a lo facturado/entregado; borrar es reducir a 0, así que sólo
 * se puede borrar si el piso es 0.
 *
 * Cinco secciones. Las cuatro primeras contra la base VIVA; la quinta,
 * sintética, porque los datos reales no ejercitan todas las ramas:
 *
 *  [1] LAS RUTAS LO EXIGEN — `delete-item-force` y `update-item-force` de
 *      orders LLAMAN a `floorDenial`. Se afirma la LLAMADA descartando las
 *      líneas de import: un check de "menciona X" lo pasa un import huérfano, y
 *      esa es exactamente la falla que §4b de verify-pin-enforcement tenía
 *      documentada desde julio y que igual se repitió en agosto.
 *
 *  [2] PARIDAD CON SEPARACIÓN — para toda orden abierta, el piso que calcula
 *      `loadLineFloors` es el mismo que sale de `loadSeparationData`. Las dos
 *      derivaciones existen a propósito (no quise refactorizar la ruta caliente
 *      de separación sólo para compartir un loader), y esta sección es lo que
 *      compra esa decisión: si alguien toca una y no la otra, acá se ve. Sin
 *      ella serían dos fórmulas del mismo número, que es cómo este repo se
 *      quemó con `liveFulfilledSql` duplicado.
 *
 *  [3] INVENTARIO DE LÍNEAS BAJO SU PISO — descriptivo, JAMÁS alarma. Al
 *      escribir esto había 14 (3 órdenes `completed`, con el fulfillment
 *      contado doble): datos rotos anteriores a la regla. Ponerlas a fallar
 *      haría un rojo permanente, y un rojo permanente se termina ignorando.
 *      Lo que SÍ falla es que aparezca una en una orden EDITABLE — eso sí
 *      sería el guard sin morder.
 *
 *  [4] EL GUARD NO MUERDE DE MÁS — sobre líneas reales, `floorDenial` deja
 *      pasar: subir la cantidad, dejarla igual, y toda edición que no toque la
 *      cantidad. Sin estas aserciones NEGATIVAS un guard que rechace todo
 *      pasaría las secciones 1 y 2 en verde, y se comería el trabajo diario de
 *      un POS donde el 96% de las líneas tiene piso.
 *
 *  [5] MATRIZ SINTÉTICA — la que de verdad acredita el predicado. Las 2 y 4
 *      miden sobre datos DEGENERADOS: de las 5.332 líneas vivas con piso sólo
 *      4 tienen quantity > floor, así que "bajar al piso" y "dejarla igual"
 *      son el mismo caso en casi todo el sistema. Mutation-testeado: sin esta
 *      sección, ignorar el fulfillment y rechazar por estado en vez de por
 *      efecto pasaban las otras cuatro en verde.
 *
 * Correr: npx medusa exec ./src/scripts/verify/verify-order-line-floor.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";
import { computeFloor, floorDenial, loadLineFloors, type LineFloor } from "../../api/admin/orders/[id]/_lib/line-floors";
import { loadSeparationData } from "../../api/admin/orders/[id]/_lib/separation-data";

/**
 * Métodos del módulo Order que MUTAN una línea. Toda ruta que llame a uno de
 * estos tiene que pasar por el piso.
 */
const LINE_MUTATORS = [
  "deleteOrderLineItems",
  "softDeleteOrderLineItems",
  "updateOrderLineItems",
];

/**
 * Rutas que mutan líneas y NO llevan piso, cada una con su motivo. Una entrada
 * acá es una decisión, no un olvido — y si el motivo deja de valer, se saca.
 */
const NO_FLOOR_ALLOWLIST: Record<string, string> = {
  // (vacío a propósito: hoy las 4 rutas que mutan líneas llevan el guard)
};

/** Líneas de código reales: sin imports y sin comentarios. */
function callSites(source: string, fn: string): number {
  return source
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith("import ") || t.startsWith("//") || t.startsWith("*")) return false;
      return t.includes(`${fn}(`);
    }).length;
}

export default async function verifyOrderLineFloor({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const pool = getDbPool();
  let failures = 0;

  // ── [1] TODA ruta que muta una línea llama al guard ──────────────────────
  //
  // Esta sección afirmaba sobre una LISTA FIJA de dos archivos, y por eso pasó
  // en verde mientras las rutas GEMELAS de `draft-orders` —copias divergidas,
  // en otro prefijo de path, sin ningún control— dejaban borrar una línea
  // facturada de una orden confirmada (reproducido el 2026-09-05: 409 por
  // `orders/` y 200 por `draft-orders/`). Un guard cuya cobertura depende de que
  // alguien se acuerde de sumar el archivo a una lista no está cubierto: se
  // ENUMERAN los escritores y se exige guard o allowlist con motivo.
  const routeFiles: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "route.ts") routeFiles.push(full);
    }
  };
  walk(join(process.cwd(), "src/api"));

  const mutators = routeFiles.filter((f) => {
    const src = readFileSync(f, "utf8");
    return LINE_MUTATORS.some((m) => callSites(src, m) > 0);
  });

  let routeMisses = 0;
  for (const full of mutators) {
    const rel = full.slice(full.indexOf("src/api"));
    if (NO_FLOOR_ALLOWLIST[rel]) continue;
    const src = readFileSync(full, "utf8");
    const calls = callSites(src, "floorDenial");
    const loads = callSites(src, "loadLineFloors");
    if (calls < 1 || loads < 1) {
      routeMisses++;
      console.log(
        `  ❌ ${rel}: muta líneas pero floorDenial=${calls} loadLineFloors=${loads} (fuera de imports). Ponele el guard, o declarala en NO_FLOOR_ALLOWLIST con su motivo.`
      );
    }
  }
  // Un barrido que no encuentra NADA pasaría en vacío — el mismo defecto con
  // otro nombre.
  if (mutators.length < 2) {
    routeMisses++;
    console.log(
      `  ❌ el barrido encontró sólo ${mutators.length} ruta(s) que mutan líneas — el patrón dejó de matchear`
    );
  }
  if (routeMisses) failures++;
  console.log(
    `[1] las ${mutators.length} rutas que MUTAN líneas llaman al guard: ${routeMisses === 0 ? "OK" : `${routeMisses} sin llamada`}`
  );

  // ── órdenes abiertas ─────────────────────────────────────────────────────
  const openRes = await pool.query<{ id: string; display_id: number }>(
    `SELECT id, display_id
       FROM "order"
      WHERE is_draft_order = false
        AND deleted_at IS NULL
        AND status NOT IN ('canceled', 'archived')
      ORDER BY created_at DESC
      LIMIT 400`
  );

  // ── [2] paridad con separación ───────────────────────────────────────────
  let parityMismatches = 0;
  let comparedLines = 0;
  // Cuántas de las comparadas ejercitan la mitad del FULFILLMENT. Si es 0, esta
  // sección no puede ver una regresión de ese lado y tiene que DECIRLO — un
  // check que pasa sin cobertura es peor que uno ausente.
  let parityFulCoverage = 0;
  let missingInFloors = 0;
  for (const o of openRes.rows) {
    const floors = await loadLineFloors(pool, o.id);
    const sep = await loadSeparationData(pool, o.id);
    if (!sep) continue;
    for (const line of sep.lines) {
      const mine = floors.get(line.lineId);
      if (!mine) {
        missingInFloors++;
        continue;
      }
      comparedLines++;
      const theirs = Math.max(line.invoiced ?? 0, line.fulfilled ?? 0);
      if ((line.fulfilled ?? 0) > (line.invoiced ?? 0)) parityFulCoverage++;
      if (mine.floor !== theirs) {
        parityMismatches++;
        console.log(
          `  ❌ S${o.display_id} ${line.lineId}: piso guard=${mine.floor} (inv=${mine.invoiced} ful=${mine.fulfilled}) vs separación=${theirs} (inv=${line.invoiced} ful=${line.fulfilled})`
        );
      }
    }
  }
  // Un loader que devuelva un Map VACÍO pasaba esta sección en verde: el
  // `continue` de arriba salta toda línea ausente, así que cero comparaciones
  // se leían como cero divergencias. Se exige cobertura real y, además, que los
  // dos loaders vean EL MISMO conjunto de líneas — sin eso, el guard podría
  // estar apagado de raíz y §2 no se enteraría.
  if (comparedLines === 0 && openRes.rows.length > 0) {
    parityMismatches++;
    console.log(
      "  ❌ §2 no comparó NI UNA línea sobre órdenes abiertas — loadLineFloors no está devolviendo nada"
    );
  }
  if (missingInFloors > 0) {
    parityMismatches++;
    console.log(
      `  ❌ ${missingInFloors} línea(s) que separación ve y loadLineFloors NO — los dos loaders no ven el mismo conjunto`
    );
  }
  if (parityMismatches) failures++;
  console.log(
    `[2] paridad piso guard↔separación sobre ${comparedLines} líneas: ${
      parityMismatches === 0 ? "OK" : `${parityMismatches} divergencia(s)`
    } — de ellas ${parityFulCoverage} ejercitan el fulfillment${
      parityFulCoverage === 0 ? " ⚠️  SIN COBERTURA de esa mitad (la cubre §5)" : ""
    }`
  );

  // ── [3] inventario de líneas bajo su piso ────────────────────────────────
  const belowRes = await pool.query<{
    display_id: number;
    status: string;
    line_id: string;
    qty: string;
    floor: string;
  }>(
    `WITH ln AS (
       SELECT o.display_id, o.status, oli.id AS line_id,
              oi.quantity AS qty,
              GREATEST(
                COALESCE((SELECT SUM(ffi.quantity)
                            FROM order_fulfillment ofl
                            JOIN fulfillment f ON f.id = ofl.fulfillment_id
                             AND f.canceled_at IS NULL AND f.deleted_at IS NULL
                            JOIN fulfillment_item ffi ON ffi.fulfillment_id = f.id
                             AND ffi.deleted_at IS NULL
                           WHERE ofl.order_id = oi.order_id AND ofl.deleted_at IS NULL
                             AND ffi.line_item_id = oli.id), 0),
                COALESCE((SELECT SUM(pii.quantity)
                            FROM pos_invoice_item pii
                            JOIN pos_invoice pi ON pi.id = pii.invoice_id
                             AND pi.deleted_at IS NULL
                             AND pi.status NOT IN ('voided','draft')
                           WHERE pii.order_line_item_id = oli.id
                             AND pii.deleted_at IS NULL), 0)
              ) AS floor
         FROM order_item oi
         JOIN "order" o ON o.id = oi.order_id AND oi.version = o.version
         JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
        WHERE o.is_draft_order = false AND oi.deleted_at IS NULL
     )
     SELECT display_id, status, line_id, qty::text, floor::text
       FROM ln WHERE qty < floor ORDER BY display_id`
  );
  const editableBelow = belowRes.rows.filter(
    (r) => r.status !== "completed" && r.status !== "canceled" && r.status !== "archived"
  );
  console.log(
    `[3] líneas ya bajo su piso: ${belowRes.rows.length} (inventario, no alarma) — en órdenes EDITABLES: ${editableBelow.length}`
  );
  for (const r of editableBelow) {
    console.log(`  ❌ S${r.display_id} (${r.status}) ${r.line_id}: qty=${r.qty} < piso=${r.floor}`);
  }
  if (editableBelow.length) failures++;

  // ── [4] el guard no muerde de más ────────────────────────────────────────
  let falsePositives = 0;
  let checkedNegatives = 0;
  for (const o of openRes.rows.slice(0, 60)) {
    const floors = await loadLineFloors(pool, o.id);
    for (const f of floors.values()) {
      if (f.floor <= 0) continue;
      checkedNegatives++;
      const cases: Array<[string, ReturnType<typeof floorDenial>]> = [
        ["subir la cantidad", floorDenial(f, f.quantity + 1)],
        ["dejarla igual", floorDenial(f, f.quantity)],
        ["no tocar la cantidad", floorDenial(f, undefined)],
        ["bajar exactamente al piso", floorDenial(f, f.floor)],
      ];
      for (const [what, denial] of cases) {
        if (denial) {
          falsePositives++;
          console.log(`  ❌ S${o.display_id} ${f.lineId}: el guard bloqueó "${what}" (piso=${f.floor}, qty=${f.quantity})`);
        }
      }
      // Control POSITIVO: bajo el piso SÍ se rechaza, o los negativos de arriba
      // no acreditan nada (un guard apagado los pasa todos).
      if (f.floor > 0 && f.quantity >= f.floor && !floorDenial(f, f.floor - 1)) {
        falsePositives++;
        console.log(`  ❌ S${o.display_id} ${f.lineId}: el guard DEJÓ PASAR bajar a ${f.floor - 1} con piso ${f.floor}`);
      }
    }
  }
  // Igual que §2: sin líneas con piso, esta sección no evalúa NADA y su OK no
  // significa nada. Sobre una base donde el 96% de las líneas tiene piso, cero
  // es prueba de que el loader no está trayendo lo que dice.
  if (checkedNegatives === 0) {
    falsePositives++;
    console.log(
      "  ❌ §4 no evaluó NI UNA línea con piso — el loader no está devolviendo pisos"
    );
  }
  if (falsePositives) failures++;
  console.log(
    `[4] el guard no muerde de más, sobre ${checkedNegatives} líneas con piso: ${
      falsePositives === 0 ? "OK" : `${falsePositives} caso(s) mal`
    }`
  );

  // ── [5] matriz SINTÉTICA del predicado ───────────────────────────────────
  // Las secciones 2 y 4 miden sobre datos reales, y los datos reales son
  // DEGENERADOS: medido el 2026-09-05, de las 5.332 líneas vivas con piso sólo
  // 4 tienen quantity > floor, y en el tramo que §2 compara el facturado tapa
  // al entregado. Con eso, dos mutaciones del guard —ignorar el fulfillment, y
  // rechazar por ESTADO en vez de por EFECTO— pasaban las cuatro secciones en
  // verde. Esta matriz no depende de la forma de la base.
  const L = (over: Partial<LineFloor>): LineFloor => ({
    lineId: "l1", quantity: 10, invoiced: 0, fulfilled: 0, floor: 0, ...over,
  });
  const cases: Array<[string, boolean, boolean]> = [
    // [nombre, hay denegación esperada, hay denegación real]
    ["sin piso, borrar se permite",
      false, !!floorDenial(L({}), null, { deleting: true })],
    ["con piso, borrar se RECHAZA",
      true, !!floorDenial(L({ invoiced: 3, floor: 3 }), null, { deleting: true })],
    ["el piso lo puede fijar el ENTREGADO solo",
      true, !!floorDenial(L({ fulfilled: 3, floor: 3 }), null, { deleting: true })],
    ["bajar al piso exacto se permite",
      false, !!floorDenial(L({ invoiced: 4, floor: 4 }), 4)],
    ["bajar UNO por debajo del piso se rechaza",
      true, !!floorDenial(L({ invoiced: 4, floor: 4 }), 3)],
    ["subir por encima se permite",
      false, !!floorDenial(L({ invoiced: 4, floor: 4 }), 12)],
    ["no tocar la cantidad se permite",
      false, !!floorDenial(L({ invoiced: 4, floor: 4 }), undefined)],
    // La rama que protege a las 14 lineas rotas de produccion.
    ["ya bajo el piso: dejarla igual se permite",
      false, !!floorDenial(L({ quantity: 2, fulfilled: 10, floor: 10 }), 2)],
    ["ya bajo el piso: SUBIRLA se permite",
      false, !!floorDenial(L({ quantity: 2, fulfilled: 10, floor: 10 }), 5)],
    ["ya bajo el piso: bajarla MAS se rechaza",
      true, !!floorDenial(L({ quantity: 2, fulfilled: 10, floor: 10 }), 1)],
    ["ya bajo el piso: borrarla se rechaza",
      true, !!floorDenial(L({ quantity: 2, fulfilled: 10, floor: 10 }), null, { deleting: true })],
    // El agujero que encontró la auditoría del 2026-09-05.
    ["cantidad 0 con piso 3: borrar se RECHAZA",
      true, !!floorDenial(L({ quantity: 0, invoiced: 3, floor: 3 }), null, { deleting: true })],
    ["una linea que el loader no conoce no bloquea",
      false, !!floorDenial(undefined, 0, { deleting: true })],
    // La CONSTRUCCION del piso, que §2 no puede ver: en los datos reales el
    // facturado siempre tapa al entregado, asi que un piso que ignore el
    // fulfillment pasa desapercibido.
    ["el piso es el MAYOR, no el facturado", computeFloor(2, 7) === 7, true],
    ["el piso es el MAYOR, no el entregado", computeFloor(9, 3) === 9, true],
    ["el piso NO es la suma", computeFloor(4, 4) === 4, true],
  ];
  let matrixBad = 0;
  for (const [name, want, got] of cases) {
    if (want !== got) {
      matrixBad++;
      console.log(`  ❌ ${name}: esperaba ${want ? "RECHAZO" : "permitido"}, dio ${got ? "RECHAZO" : "permitido"}`);
    }
  }
  if (matrixBad) failures++;
  console.log(
    `[5] matriz sintética del predicado (${cases.length} casos): ${matrixBad === 0 ? "OK" : `${matrixBad} mal`}`
  );

  if (failures) {
    throw new Error(`[verify-order-line-floor] ${failures} sección(es) FALLARON`);
  }
  logger.info("[verify-order-line-floor] ✅ todas las secciones OK");
}
