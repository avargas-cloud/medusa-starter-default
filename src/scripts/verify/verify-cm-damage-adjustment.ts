/**
 * Invariantes del ajuste de inventario por defectuosos de un credit memo.
 *
 * Read-only y sin base de datos: audita el CÓDIGO. Existe porque la mitad de
 * las formas de romper este mecanismo no producen ningún error — producen
 * silencio, que es peor.
 *
 * Lo que cada bloque protege, y de qué incidente viene:
 *
 *  1. Los CUATRO caminos llaman al chokepoint. La carrera void-vs-ADD costó una
 *     factura viva y huérfana en QuickBooks porque el guard existía y era
 *     correcto pero vivía en UN camino, y el documento entró por el otro. La
 *     regla no es "poner el guard", es que todo camino llame al mismo lugar —
 *     y eso se afirma por NOMBRE, no por lo que el archivo mencione.
 *
 *  2. El ADD nunca re-despacha a ciegas. Dos submits de un ADD son dos
 *     documentos; un segundo ajuste rompe la premisa entera de este diseño
 *     ("un credit memo, un ajuste"). El MOD y el VOID sí, y tienen que estarlo:
 *     un step materializable que no es despachable queda 'pending' para siempre.
 *
 *  3. El Mod nunca manda cantidades absolutas. `NewQuantity` es la forma del
 *     conteo físico, donde el POS ES la autoridad del on-hand. Acá no lo es:
 *     un absoluto pisaría cualquier venta o recepción que QuickBooks haya
 *     registrado entre medio.
 *
 *  4. El void del credit memo espera al de su ajuste. El neto es el mismo en
 *     cualquier orden; el camino no: al revés, el on-hand de QB puede pasar por
 *     negativo.
 *
 *  5. El void del credit memo encola el ajuste ANTES que a sí mismo. El gate de
 *     quiescencia sólo bloquea con filas creadas antes —la cláusula que impide
 *     que dos voids se bloqueen mutuamente para siempre— así que si la llamada
 *     se mueve después del enqueue del `void_credit_memo`, el punto 4 se apaga
 *     sin que nada falle.
 *
 * Correr: ./node_modules/.bin/tsx src/scripts/verify/verify-cm-damage-adjustment.ts
 */

import { readFileSync } from "fs";
import { join } from "path";

import {
  buildDamageMemo,
  buildDamageRefNumber,
} from "../../lib/quickbooks/damage/sync-damage-adjustment";
import { damageModIsNoop } from "../../lib/quickbooks/damage/refresh-damage-snapshot";

const SRC = join(__dirname, "..", "..");
let failures = 0;

function ok(name: string): void {
  console.log(`  ✓ ${name}`);
}

function bad(name: string, detail: string): void {
  failures++;
  console.log(`  ✗ ${name}\n      ${detail}`);
}

function assert(name: string, cond: boolean, detail: string): void {
  cond ? ok(name) : bad(name, detail);
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * Cuerpo de un `case "x": … ` del switch, hasta la SIGUIENTE etiqueta case.
 *
 * Deliberadamente NO es una ventana de tamaño fijo: un verificador que escanea
 * N caracteres miente el día que alguien agrega un comentario largo, y este
 * repo ya perdió una tarde por un `case` que creció 70 caracteres.
 */
function caseBody(src: string, step: string): string | null {
  const start = src.indexOf(`case "${step}":`);
  if (start === -1) return null;
  const after = src.slice(start + `case "${step}":`.length);
  const next = after.search(/\n\s*case "/);
  return next === -1 ? after : after.slice(0, next);
}

console.log("\n── 1. Los cuatro caminos llaman al chokepoint ─────────────────");

const CHOKEPOINT = "syncCreditMemoDamageAdjustment";
const ROUTES = [
  "api/admin/pos/credit_memos/[id]/complete/route.ts",
  "api/admin/pos/credit_memos/[id]/edit/route.ts",
  "api/admin/pos/credit_memos/[id]/damaged/route.ts",
  "api/admin/pos/credit_memos/[id]/void/route.ts",
];

for (const route of ROUTES) {
  const src = read(route);
  assert(
    `${route.split("/").slice(-2)[0]} llama a ${CHOKEPOINT}`,
    new RegExp(`await\\s+${CHOKEPOINT}\\(`).test(src),
    `esa ruta muta defectuosos y no reconcilia el ajuste — QuickBooks quedaría desincronizado en silencio`
  );
}

console.log("\n── 2. Despacho y recuperación por step ────────────────────────");

const dispatch = read("lib/quickbooks/consolidator/dispatch-pass.ts");
const recovery = read("lib/quickbooks/consolidator/recovery-pass.ts");
const resubmit = read("lib/quickbooks/consolidator/resubmit-by-step.ts");

const STEPS = [
  "cm_damage_adjustment",
  "cm_damage_adjustment_mod",
  "void_cm_damage_adjustment",
];

for (const step of STEPS) {
  assert(
    `${step} está en la lista de dispatch`,
    dispatch.includes(`'${step}'`) || dispatch.includes(`"${step}"`),
    "la fila quedaría 'pending' para siempre — nadie la reclama"
  );
  assert(
    `${step} tiene case en resubmit-by-step`,
    caseBody(resubmit, step) !== null,
    "el dispatcher la reclamaría y caería al default"
  );
}

assert(
  "el ADD NO está en IDEMPOTENT_REDISPATCH_STEPS",
  !new RegExp(`"cm_damage_adjustment"`).test(recovery),
  "un re-submit a ciegas del ADD mintearía un SEGUNDO ajuste en QuickBooks"
);
for (const step of ["cm_damage_adjustment_mod", "void_cm_damage_adjustment"]) {
  assert(
    `${step} SÍ está en IDEMPOTENT_REDISPATCH_STEPS`,
    recovery.includes(`"${step}"`),
    "una fila huérfana en 'processing' no se recuperaría nunca"
  );
}

console.log("\n── 3. El Mod nunca manda cantidades absolutas ─────────────────");

const client = read("lib/quickbooks/client/inventory-adjustments.ts");
const modFnStart = client.indexOf("export async function postDamageAdjustmentModToQb");
const addFnStart = client.indexOf("export async function postDamageAdjustmentAddToQb");
const queryFnStart = client.indexOf("export async function queryInventoryAdjustmentInQb");
const modFn = client.slice(modFnStart, queryFnStart > modFnStart ? queryFnStart : undefined);
const addFn = client.slice(addFnStart, modFnStart > addFnStart ? modFnStart : undefined);

assert(
  "el Add de defectuosos manda quantity_difference",
  addFn.includes("quantity_difference"),
  "sin delta signado el ajuste no puede expresar un write-off"
);
assert(
  "el Add de defectuosos NO manda new_quantity",
  !addFn.includes("new_quantity"),
  "un absoluto pisaría el on-hand real de QuickBooks"
);
assert(
  "el Mod de defectuosos NO manda new_quantity",
  !modFn.includes("new_quantity"),
  "un absoluto pisaría el on-hand real de QuickBooks"
);
assert(
  "el Mod lee la identidad de las líneas de QuickBooks (qb_line_ids)",
  modFn.includes("qb_line_ids"),
  "armar los TxnLineID de memoria borra por omisión las líneas que no nombra"
);
assert(
  "el dispatch del Mod refresca el snapshot contra QB en cada intento",
  (caseBody(resubmit, "cm_damage_adjustment_mod") ?? "").includes(
    "fetchDamageAdjustmentSnapshot"
  ),
  "un EditSequence cacheado da QB 3200 en cada reintento"
);

console.log("\n── 4. Orden: el void del credit memo espera al del ajuste ─────");

const quiescence = read("lib/quickbooks/pipeline/document-quiescence.ts");
const voidCmBlockers = quiescence.slice(
  quiescence.indexOf("void_credit_memo: ["),
  quiescence.indexOf("void_sales_order:")
);
for (const step of STEPS) {
  assert(
    `void_credit_memo bloquea con ${step}`,
    voidCmBlockers.includes(`"${step}"`),
    "el void del credit memo podría adelantarse y dejar el on-hand de QB en negativo"
  );
}
assert(
  "void_cm_damage_adjustment tiene sus propios bloqueantes",
  quiescence.includes("void_cm_damage_adjustment: ["),
  "voidear el ajuste mientras su Mod viaja los corre en carrera"
);
assert(
  "el case del void del ajuste pasa por el gate",
  (caseBody(resubmit, "void_cm_damage_adjustment") ?? "").includes(
    "voidBlockedByLiveMutation"
  ),
  "sin el gate el void puede adelantarse a su propio Mod"
);

console.log("\n── 5. El void encola el ajuste ANTES que a sí mismo ───────────");

const voidRoute = read("api/admin/pos/credit_memos/[id]/void/route.ts");
// Anclas PRECISAS a propósito. La primera versión de este check comparaba
// `indexOf(CHOKEPOINT)` contra `indexOf("void_credit_memo")` y era VACUA: la
// primera aparición del chokepoint es su línea de `import`, arriba de todo, así
// que la comparación daba verdadera pasara lo que pasara — y el mutation test
// que movió la llamada al final del handler no la hizo fallar. Se busca la
// LLAMADA (`await …(`) y el ENQUEUE real (`step: "void_credit_memo"`), no
// cualquier mención del nombre en un comentario o un import.
const syncPos = voidRoute.search(new RegExp(`await\\s+${CHOKEPOINT}\\(`));
const voidEnqueuePos = voidRoute.indexOf('step: "void_credit_memo"');
assert(
  "la llamada al chokepoint precede al enqueue del void_credit_memo",
  syncPos !== -1 && voidEnqueuePos !== -1 && syncPos < voidEnqueuePos,
  "el gate de quiescencia sólo bloquea con filas creadas ANTES: si esta llamada " +
    "queda después, el punto 4 se apaga entero sin que nada falle"
);
assert(
  "la llamada del void usa forceEmpty",
  /forceEmpty:\s*true/.test(voidRoute),
  "sin él lee el credit memo todavía vivo y encola un Mod en vez del void"
);

console.log("\n── 6. Confirmación: el credit memo se entera de su ajuste ─────");

const poller = read("lib/quickbooks/consolidator/poll-submitted-rows.ts");
assert(
  "el poller persiste el TxnID del ajuste en el credit memo",
  poller.includes("qb_inventory_adjustment_txn_id = $2"),
  "sin este stamp el próximo cambio crearía un SEGUNDO ajuste en vez de editar el primero"
);
assert(
  "el poller persiste el EditSequence junto al TxnID",
  poller.includes("qb_inventory_adjustment_edit_sequence"),
  "un TxnID sin EditSequence no sirve para ningún Mod posterior"
);
assert(
  "el poller libera el puntero al confirmar el void",
  poller.includes("qb_inventory_adjustment_txn_id = NULL"),
  "el próximo defectuoso intentaría un Mod sobre un documento voideado"
);
assert(
  "el poller extrae el TxnID de InventoryAdjustmentAddRs",
  poller.includes("InventoryAdjustmentAddRs"),
  "el confirm no encontraría el TxnID y nunca lo persistiría"
);

console.log("\n── 7. Lógica pura ────────────────────────────────────────────");

assert(
  "el ref se deriva del número de credit memo",
  buildDamageRefNumber("CM-1234") === "DMG1234",
  `esperaba DMG1234, dio ${buildDamageRefNumber("CM-1234")}`
);
assert(
  "el ref respeta el tope de 11 caracteres de QuickBooks",
  buildDamageRefNumber("CM-123456789012").length <= 11,
  "QuickBooks corta el RefNumber y dos ajustes distintos podrían colisionar"
);
assert(
  "el memo nombra el credit memo",
  buildDamageMemo("CM-1234") === "CM-1234 defective products",
  `dio "${buildDamageMemo("CM-1234")}"`
);
assert(
  "no-op detectado cuando el estado coincide",
  damageModIsNoop({ A: -1, B: -2 }, { current_quantities: { B: -2, A: -1 } }),
  "se despacharía un Mod que no cambia nada y movería el EditSequence sin motivo"
);
assert(
  "cambio de cantidad NO es no-op",
  !damageModIsNoop({ A: -2 }, { current_quantities: { A: -1 } }),
  "saltearlo dejaría QuickBooks con la cantidad vieja, en silencio"
);
assert(
  "SKU nuevo NO es no-op",
  !damageModIsNoop({ A: -1, B: -1 }, { current_quantities: { A: -1 } }),
  "la línea nueva nunca llegaría a QuickBooks"
);
assert(
  "SKU que desaparece NO es no-op",
  !damageModIsNoop({ A: -1 }, { current_quantities: { A: -1, B: -1 } }),
  "la línea sobrante seguiría descontando stock en QuickBooks"
);
assert(
  "sin foto del estado vivo NUNCA se declara no-op",
  !damageModIsNoop({ A: -1 }, {}),
  "ante la duda hay que despachar: saltear un Mod necesario rompe QB en silencio"
);

console.log(
  failures === 0
    ? "\n✅ PASS — invariantes del ajuste de defectuosos verificados\n"
    : `\n❌ FAIL — ${failures} invariante(s) rotos\n`
);
process.exit(failures === 0 ? 0 : 1);
