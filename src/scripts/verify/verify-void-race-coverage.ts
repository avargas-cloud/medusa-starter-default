/**
 * Verifica que la cobertura contra la carrera void-before-create siga completa.
 *
 * El bug de la POS Invoice 21246 no fue una lógica equivocada: el guard existía
 * y era correcto, pero vivía en UN camino de confirmación mientras el documento
 * confirmó por otro. La clase de regresión, entonces, no es "el guard está mal"
 * — es "apareció un camino nuevo que no lo llama". Un type-check no lo ve y un
 * E2E tampoco, porque el camino nuevo funciona perfecto para todo lo demás.
 *
 * Tres invariantes, todos leídos del fuente:
 *
 *   1. Todo archivo que confirme un ADD inline (escribe una fila 'confirmed'
 *      con el ternario submitted/confirmed) llama a `enqueueVoidIfAlreadyVoided`.
 *   2. Todo step de void materializable tiene su entrada en el mapa de
 *      bloqueantes del gate de quiescencia (si no, el gate lo deja pasar mudo).
 *   3. Todo `case "void_*"` de `resubmit-by-step` pasa por el gate.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-void-race-coverage.ts
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");

/** Caminos que confirman un ADD inline y por lo tanto deben llamar al hook. */
const INLINE_CONFIRM_PATHS = [
  "lib/quickbooks/handlers/handle-fulfillment-created.ts",
  "lib/quickbooks/handlers/handle-sales-receipt-created.ts",
  "lib/quickbooks/handlers/handle-order-placed.ts",
  "lib/quickbooks/handlers/handle-pos-payment-created.ts",
  "subscribers/qb-draft-order-subscriber.ts",
];

/** El camino asíncrono del consolidator. */
const CONSOLIDATOR_CONFIRM = "lib/quickbooks/consolidator/poll-submitted-rows.ts";

const HOOK = "enqueueVoidIfAlreadyVoided";
const GATE = "voidBlockedByLiveMutation";

const failures: string[] = [];
const notes: string[] = [];

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), "utf8");
}

// ── 1 · Todo camino de confirmación llama al hook ────────────────────────────
for (const rel of [...INLINE_CONFIRM_PATHS, CONSOLIDATOR_CONFIRM]) {
  const src = read(rel);
  if (!src.includes(HOOK)) {
    failures.push(
      `${rel} confirma un ADD pero NO llama a ${HOOK}() — ` +
        `un void emitido durante el vuelo quedaría huérfano en QuickBooks`
    );
  } else {
    notes.push(`✓ ${rel} llama a ${HOOK}()`);
  }
}

// ── 1b · No apareció un camino de confirmación inline nuevo sin cobertura ────
// El ternario `!result.txnId ? "submitted" : "confirmed"` es la firma de un
// camino que confirma inline. Si aparece en un archivo que no está en la lista
// de arriba, o es cobertura faltante o hay que agregarlo a la lista a propósito.
const TERNARY = /\?\s*"submitted"\s*:\s*"confirmed"/;
const KNOWN = new Set([...INLINE_CONFIRM_PATHS]);
/**
 * `handle-payment-captured` es la captura web a nivel ORDEN: su fila de
 * pipeline no lleva `reference_id` porque no hay un `customer_payment` que
 * referenciar, así que no hay clave sobre la que materializar un void. Es un
 * límite estructural, no cobertura faltante.
 *
 * (`handle-pos-payment-created` SÍ llama al hook desde el delta v2 y por eso
 * salió de esta lista.)
 */
const PAYMENT_PATHS = new Set([
  "lib/quickbooks/handlers/handle-payment-captured.ts",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "scripts" || entry.name === "__tests__") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

for (const abs of walk(SRC)) {
  const rel = path.relative(SRC, abs);
  if (KNOWN.has(rel) || PAYMENT_PATHS.has(rel)) continue;
  const src = fs.readFileSync(abs, "utf8");
  if (TERNARY.test(src) && !src.includes(HOOK)) {
    failures.push(
      `${rel} confirma un ADD inline (ternario submitted/confirmed) y no llama a ${HOOK}(). ` +
        `Agregá la llamada, o sumá el archivo a INLINE_CONFIRM_PATHS/PAYMENT_PATHS con el motivo.`
    );
  }
}

// ── 2 · Todo void materializable tiene bloqueantes definidos ────────────────
const quiescence = read("lib/quickbooks/pipeline/document-quiescence.ts");
const voidIntent = read("lib/quickbooks/pipeline/void-intent.ts");

const materializable = [
  ...voidIntent.matchAll(/"(void_[a-z_]+)"/g),
].map((m) => m[1]);
const uniqueMaterializable = [...new Set(materializable)];

for (const step of uniqueMaterializable) {
  // Se busca la CLAVE del mapa (`  void_x: [`), no una mención cualquiera.
  const keyPattern = new RegExp(`^\\s{2}${step}:\\s*\\[`, "m");
  if (!keyPattern.test(quiescence)) {
    failures.push(
      `el step ${step} se puede materializar pero no tiene entrada en VOID_BLOCKING_STEPS — ` +
        `el gate de quiescencia lo dejaría pasar sin chequear nada`
    );
  } else {
    notes.push(`✓ ${step} tiene bloqueantes definidos`);
  }
}

// ── 3 · Todo case de void en resubmit-by-step pasa por el gate ──────────────
const resubmit = read("lib/quickbooks/consolidator/resubmit-by-step.ts");
const voidCases = [...resubmit.matchAll(/case "(void_[a-z_]+)":/g)].map(
  (m) => m[1]
);
/**
 * `void_check` es el TxnDel de un ReceivePayment/Check, no un void de documento
 * de venta: no tiene ADD ni MOD concurrente que esperar. Excluido a propósito.
 */
const GATE_EXEMPT = new Set(["void_check"]);

/**
 * Cuerpo de un `case` del switch: desde su etiqueta hasta la siguiente.
 *
 * Se scanea hasta el próximo `case "` en vez de usar una ventana de N
 * caracteres. Una ventana fija ya dio un falso positivo — un comentario de
 * ~470 chars empujó la llamada al gate fuera de los 400 que se miraban — y un
 * verificador que grita sin motivo se termina ignorando, que es exactamente
 * como pierde su valor.
 *
 * Los case apilados (`case "void_invoice": case "void_sales_receipt": {`)
 * dejan un cuerpo vacío para el primero: en ese caso se sigue hasta el
 * siguiente, que es donde vive el código compartido.
 */
function caseBody(src: string, step: string): string {
  let from = src.indexOf(`case "${step}":`);
  if (from < 0) return "";
  for (let i = 0; i < 4; i++) {
    const rest = src.slice(from + 1);
    const nextRel = rest.indexOf('case "');
    const body = nextRel < 0 ? rest : rest.slice(0, nextRel);
    // Cuerpo real (no un case apilado sobre otro).
    if (body.trim().replace(/^\{?\s*/, "").length > 40) return body;
    if (nextRel < 0) return body;
    from = from + 1 + nextRel;
  }
  return src.slice(from, from + 2000);
}

for (const step of [...new Set(voidCases)]) {
  if (GATE_EXEMPT.has(step)) continue;
  const window = caseBody(resubmit, step);
  if (!window.includes(GATE)) {
    failures.push(
      `case "${step}" de resubmit-by-step no llama a ${GATE}() — ` +
        `podría despachar contra un documento que está cambiando (3200/3210)`
    );
  } else {
    notes.push(`✓ case "${step}" pasa por el gate`);
  }
}

// ── 4 · El poller de PO re-arma su fila cuando el PO ya estaba voideado ─────
// No usa el ternario submitted/confirmed ni `writePipelineRow` — vive en otra
// tabla con un unique index de UNA fila por PO, así que su guard es un
// UPDATE in-place y ninguna de las heurísticas de arriba lo ve. Se chequea por
// nombre.
const poPoller = read("jobs/qb-purchase-order-poller.ts");
if (
  !/status\s*=\s*'voided'/.test(poPoller) ||
  !/is_void:\s*true/.test(poPoller)
) {
  failures.push(
    "jobs/qb-purchase-order-poller.ts perdió el guard de void-before-create — " +
      "un PO voideado mientras su create viajaba quedaría abierto en QuickBooks"
  );
} else {
  notes.push("✓ el poller de PO re-arma la fila si el PO ya estaba voideado");
}

// ── Reporte ──────────────────────────────────────────────────────────────────
console.log("=== verify-void-race-coverage ===\n");
for (const n of notes) console.log("  " + n);

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} hueco(s) de cobertura:\n`);
  for (const f of failures) console.error("  • " + f);
  process.exit(1);
}

console.log(`\n✅ cobertura completa (${notes.length} invariantes verificados)`);
