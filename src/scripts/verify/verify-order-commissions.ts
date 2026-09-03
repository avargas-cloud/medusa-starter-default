/**
 * verify-order-commissions.ts — gate estático del Commissions Pipeline.
 *
 * Correr con: ./node_modules/.bin/tsx src/scripts/verify/verify-order-commissions.ts
 *
 * Afirma POR NOMBRE que los dos steps del lane (`commission_check`,
 * `commission_payment`) están registrados en cada lector que los necesita —
 * la lección del vendor_bill_payment_check (3 lectores del scope) y del
 * void_payment (case sin listas de dispatch = fila pending eterna):
 *
 *   1. runPendingDispatchPass los reclama (lista de steps).
 *   2. resubmit-by-step tiene case propio para cada uno, y ese case llama al
 *      handler (escaneo hasta el próximo `case "` — nunca ventana fija).
 *   3. poll-submitted-rows tiene hook de confirm para cada uno.
 *   4. sales-pipeline-scope los EXCLUYE del Sales Pipeline vía
 *      COMMISSION_PIPELINE_STEPS dentro de SALES_PIPELINE_EXCLUDED_STEPS.
 *   5. PipelineStep (types) los tipa.
 *   6. El handler manda Idempotency-Key 1:1 por fila y el payment leg pasa
 *      depositAccount (el invariante clearing=$0 depende de eso).
 *   7. El allowlist de bills service acepta la cuenta de comisión (caso 1).
 *   8. La ruta de settle exige method y compensa el post-commit fallado.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import { evaluateRetryGate } from "../../lib/quickbooks/pipeline/retry-gate";

const ROOT = resolve(__dirname, "../../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}`);
  }
};

const STEPS = ["commission_check", "commission_payment"] as const;

console.log("verify-order-commissions — registro del Commissions Pipeline\n");

// 1 · dispatch-pass
{
  const src = read("src/lib/quickbooks/consolidator/dispatch-pass.ts");
  for (const step of STEPS) {
    check(`dispatch-pass reclama '${step}'`, src.includes(`'${step}'`));
  }
}

// 2 · resubmit-by-step: case propio que invoca el handler correcto
{
  const src = read("src/lib/quickbooks/consolidator/resubmit-by-step.ts");
  const caseBody = (step: string): string | null => {
    const label = `case "${step}":`;
    const start = src.indexOf(label);
    if (start < 0) return null;
    // Hasta la PRÓXIMA etiqueta case — saltando labels apilados vacíos.
    let cursor = start + label.length;
    for (;;) {
      const next = src.indexOf(`case "`, cursor);
      const body = src.slice(start, next < 0 ? undefined : next);
      if (body.replace(label, "").trim().length > 0 || next < 0) return body;
      cursor = next + 6;
    }
  };
  const checkBody = caseBody("commission_check");
  check(
    "resubmit-by-step case commission_check → dispatchCommissionCheck",
    !!checkBody && checkBody.includes("dispatchCommissionCheck")
  );
  const payBody = caseBody("commission_payment");
  check(
    "resubmit-by-step case commission_payment → dispatchCommissionPayment",
    !!payBody && payBody.includes("dispatchCommissionPayment")
  );
}

// 3 · poller: hooks de confirm
{
  const src = read("src/lib/quickbooks/consolidator/poll-submitted-rows.ts");
  check(
    "poller estampa settlement al confirmar commission_check",
    src.includes(`row.step === "commission_check"`) &&
      src.includes("qb_check_txn_id")
  );
  check(
    "poller cierra settlement+recipient al confirmar commission_payment",
    src.includes(`row.step === "commission_payment"`) &&
      src.includes("qb_payment_txn_id") &&
      src.includes("state = 'closed'")
  );
}

// 4 · scope: excluidos del Sales Pipeline
{
  const src = read("src/lib/quickbooks/pipeline/sales-pipeline-scope.ts");
  check(
    "COMMISSION_PIPELINE_STEPS exportado con ambos steps",
    src.includes("COMMISSION_PIPELINE_STEPS") &&
      STEPS.every((s) => src.includes(`"${s}"`))
  );
  const excludedBlock = src.slice(src.indexOf("SALES_PIPELINE_EXCLUDED_STEPS"));
  // Línea VIVA (no comentada): un `// ...COMMISSION_PIPELINE_STEPS` también
  // contiene el string — la mutación que este check tiene que cazar.
  const liveSpread = excludedBlock
    .split("\n")
    .some((line) => line.trim().startsWith("...COMMISSION_PIPELINE_STEPS"));
  check("COMMISSION_PIPELINE_STEPS dentro de SALES_PIPELINE_EXCLUDED_STEPS", liveSpread);
}

// 5 · tipos
{
  const src = read("src/lib/quickbooks/pipeline/types.ts");
  for (const step of STEPS) {
    check(`PipelineStep tipa '${step}'`, src.includes(`| "${step}"`));
  }
}

// 6 · handler: idempotencia 1:1 + depositAccount
{
  const src = read("src/lib/quickbooks/handlers/handle-commission-settlement.ts");
  check(
    "check leg manda Idempotency-Key commission-check:<rowId>",
    src.includes("`commission-check:${row.id}`")
  );
  check(
    "payment leg manda Idempotency-Key commission-payment:<rowId>",
    src.includes("`commission-payment:${row.id}`")
  );
  check(
    "payment leg pasa depositAccount (clearing) y autoApply:false",
    src.includes("depositAccount") && src.includes("autoApply: false")
  );
}

// 7 · allowlist de bills service (caso 1)
{
  const src = read("src/lib/purchase-orders/vendor-bill-account-rules.ts");
  check(
    "bills service aceptan 'commission for sale:referral'",
    src.includes(`"commission for sale:referral"`)
  );
}

// 8 · ruta de settle: compensación del post-commit
{
  const src = read(
    "src/api/admin/commissions/orders/[orderId]/recipients/[recipientId]/route.ts"
  );
  check(
    "settle exige method vendor_bill|store_credit",
    src.includes(`"vendor_bill"`) && src.includes(`"store_credit"`)
  );
  check(
    "post-commit fallado COMPENSA (settlement failed + recipient approved)",
    src.includes("settle_enqueue_failed") && src.includes("state = 'approved'")
  );
}

// 9 · UNA sola derivación del monto de un beneficiario
//
// Desde que existe el modo 'fixed', "cuánto le toca" ya no es base × bps: una
// fila fija vale su monto y su % se deriva al revés. Hay DOS lectores del mismo
// dato (el modal de la orden y el listado de contabilidad) y si cada uno tiene
// su fórmula se contradicen en pantalla sin que nada falle — el patrón exacto
// que ya costó caro en el índice de órdenes y en el scope del Sales Pipeline.
// Por eso `recipientAmountCents` (la fórmula CRUDA por porcentaje) queda
// encapsulada dentro del calculador y todo lector pasa por `effectiveAmountCents`.
{
  const READERS = [
    "src/api/admin/commissions/orders/[orderId]/route.ts",
    "src/api/admin/commissions/route.ts",
  ];
  for (const rel of READERS) {
    const src = read(rel);
    check(
      `${rel.split("/").slice(-2).join("/")} deriva el monto con effectiveAmountCents`,
      src.includes("effectiveAmountCents")
    );
    check(
      `${rel.split("/").slice(-2).join("/")} NO usa la fórmula cruda recipientAmountCents`,
      !src.includes("recipientAmountCents")
    );
    check(
      `${rel.split("/").slice(-2).join("/")} sirve amount_mode al cliente`,
      src.includes("amount_mode")
    );
  }

  // El cap se mide en PORCENTAJE incluso para las filas fijas: si el escritor
  // dejara de convertirlas, un monto fijo sería la vía para saltear el tope.
  const writer = read("src/lib/commissions/writer.ts");
  check(
    "el escritor rechaza un monto fijo sobre base 0 (cap no evaluable)",
    writer.includes("undeterminedFixed") && writer.includes("fixed_amount_without_base")
  );
  check(
    "approve congela POR MODO, no reconstruyendo desde bps",
    writer.includes("effectiveAmountCents(asInt(row.base_cents)")
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 2/3/4 — un bill vivo un settlement, void re-guardable, cap post-void,
// cap congelado, canceled no comisiona, 1099 por vendor efectivo, guards de
// ruta, y orden del guard commission_retry_needs_qb_check vs el claim.
//
// Helper: cortar el cuerpo de una función exportada hasta la PRÓXIMA
// declaración `export` de nivel superior — nunca ventana fija de caracteres
// (la lección de sales-pipeline-scope y del switch de 400 chars).
// ─────────────────────────────────────────────────────────────────────────
const funcBody = (src: string, marker: string): string => {
  const start = src.indexOf(marker);
  if (start < 0) return "";
  const next = src.indexOf("\nexport ", start + marker.length);
  return next < 0 ? src.slice(start) : src.slice(start, next);
};

// 10 (Fase 2 · check 1) · migración de unicidad bill↔settlement vivo
{
  let migration: string | null = null;
  try {
    migration = read("src/migrations/1783000000000-AddCommissionSettlementBillUniqueness.ts");
  } catch {
    migration = null;
  }
  if (migration === null) {
    check("migración AddCommissionSettlementBillUniqueness1783000000000 existe", false);
  } else {
    const upStart = migration.indexOf("public async up");
    const downStart = migration.indexOf("public async down");
    const upBody = upStart >= 0 && downStart > upStart ? migration.slice(upStart, downStart) : "";
    check(
      "migración crea uq_cset_live_per_bill sobre commission_settlement(vendor_bill_id)",
      upBody.includes("CREATE UNIQUE INDEX IF NOT EXISTS uq_cset_live_per_bill") &&
        upBody.includes("ON commission_settlement (vendor_bill_id)")
    );
    check(
      "el índice cubre pending/qb_waiting/confirmed y NO failed/reversed (libres para reintento)",
      upBody.includes("status IN ('pending','qb_waiting','confirmed')") &&
        !upBody.includes("'failed'") &&
        !upBody.includes("'reversed'")
    );
  }
}

// 11 (Fase 2 · check 2) · validateVendorBillForSettlement detecta reuso del bill
{
  const src = read("src/lib/commissions/settle.ts");
  const body = funcBody(src, "export async function validateVendorBillForSettlement");
  check(
    "validateVendorBillForSettlement consulta s.vendor_bill_id = $1 y nombra bill_already_settled",
    !!body && body.includes("s.vendor_bill_id = $1") && body.includes("bill_already_settled")
  );
}

// 12 (Fase 2 · check 3) · insertSettlement discrimina el 23505 por constraint
{
  const src = read("src/lib/commissions/settle.ts");
  const body = funcBody(src, "export async function insertSettlement");
  check(
    "insertSettlement discrimina 23505 por constraint (uq_cset_live_per_bill + uq_cset_idempotency)",
    !!body &&
      body.includes(`pgErr.code === "23505"`) &&
      body.includes("uq_cset_live_per_bill") &&
      body.includes("uq_cset_idempotency")
  );
}

// 13 (Fase 2 · check 4) · reconcileVendorBillSettlements filtra bills borrados
{
  const src = read("src/lib/commissions/settle.ts");
  const body = funcBody(src, "export async function reconcileVendorBillSettlements");
  check(
    "reconcileVendorBillSettlements joinea vendor_bill con deleted_at IS NULL",
    !!body && body.includes("JOIN vendor_bill vb ON vb.id = s.vendor_bill_id AND vb.deleted_at IS NULL")
  );
}

// 14 (Fase 2 · check 5) · canReSaveAssignment acepta void además de draft
{
  const src = read("src/lib/commissions/transitions.ts");
  const body = funcBody(src, "export function canReSaveAssignment");
  check(
    "canReSaveAssignment acepta 'draft' Y 'void' (voidear a un beneficiario no traba el re-guardado)",
    !!body && body.includes(`s === "draft"`) && body.includes(`s === "void"`)
  );
}

// 15 (Fase 3 · check 6, EL MÁS IMPORTANTE) · refreshCommission filtra los
// voideados ANTES de pasarlos a checkCombinedCap. Sin unit test posible (pide
// PoolClient vivo): este check estático es la única red.
{
  const src = read("src/lib/commissions/writer.ts");
  const body = funcBody(src, "export async function refreshCommission");
  const capCallStart = body.indexOf("checkCombinedCap(");
  const capCallEnd = capCallStart >= 0 ? body.indexOf("});", capCallStart) : -1;
  const capCallSlice = capCallStart >= 0 && capCallEnd >= 0 ? body.slice(capCallStart, capCallEnd) : "";
  const liveVoidFilter = capCallSlice
    .split("\n")
    .some((line) => line.trim().startsWith(`.filter((r) => r.state !== "void")`));
  const filterBeforeMap =
    liveVoidFilter && capCallSlice.indexOf(".filter(") < capCallSlice.indexOf(".map(");
  check(
    "refreshCommission filtra recipients state !== 'void' ANTES de pasarlos a checkCombinedCap",
    !!capCallSlice && liveVoidFilter && filterBeforeMap
  );
}

// 16 (Fase 3 · check 7) · el cap mide contra el cap_bps CONGELADO, no el global
{
  const src = read("src/lib/commissions/writer.ts");
  const body = funcBody(src, "export async function refreshCommission");
  const capCallStart = body.indexOf("checkCombinedCap(");
  const capCallEnd = capCallStart >= 0 ? body.indexOf("});", capCallStart) : -1;
  const capCallSlice = capCallStart >= 0 && capCallEnd >= 0 ? body.slice(capCallStart, capCallEnd) : "";
  check(
    "refreshCommission pasa existing.commission.cap_bps (congelado) a checkCombinedCap, NO config.capBps",
    !!capCallSlice &&
      capCallSlice.includes("capBps: existing.commission.cap_bps") &&
      !capCallSlice.includes("config.capBps")
  );
}

// 17 (Fase 3 · check 8) · el GET de la orden sirve cap_exceeded/cap_undetermined
{
  const src = read("src/api/admin/commissions/orders/[orderId]/route.ts");
  check(
    "GET orders/:orderId sirve cap_exceeded y cap_undetermined",
    src.includes("cap_exceeded:") && src.includes("cap_undetermined:")
  );
}

// 18 (Fase 3 · check 9) · el listado calcula el cap con checkCombinedCap, NUNCA
// replicando la suma en SQL — dos fórmulas del mismo dato es la clase de bug
// que ya costó caro en este feature (comentario del check 9 viejo, más arriba).
{
  const src = read("src/api/admin/commissions/route.ts");
  check(
    "listado importa y LLAMA checkCombinedCap (no replica la suma)",
    src.includes("checkCombinedCap") &&
      /\bcheckCombinedCap\(\{/.test(src)
  );
  check(
    "el SQL del listado NO suma percent_bps a mano (SUM(r.percent_bps) ausente)",
    !src.includes("SUM(r.percent_bps)")
  );
}

// 19 (Fase 3 · check 10) · saveAssignment rechaza una orden 'canceled'
{
  const src = read("src/lib/commissions/writer.ts");
  const body = funcBody(src, "export async function saveAssignment");
  check(
    "saveAssignment rechaza orderStatus==='canceled' con code order_not_commissionable",
    !!body &&
      body.includes("NON_COMMISSIONABLE_ORDER_STATUSES.has(input.orderStatus)") &&
      body.includes(`"order_not_commissionable"`)
  );
}

// 20 (Fase 3 · check 11) · approve y settle rechazan canceled; void NO.
// Criterio robusto: contar SÓLO las líneas donde el string es el ARGUMENTO
// de un `new CommissionError(` (línea propia terminada en coma) — eso son
// los DOS sitios que TIRAN el error (approve, handleSettle). Las líneas que
// sólo MAPEAN err.code a un status HTTP (`err.code === "order_not_commissionable"`)
// no cuentan: esas no deciden si canceled bloquea, solo el status de la respuesta.
{
  const src = read(
    "src/api/admin/commissions/orders/[orderId]/recipients/[recipientId]/route.ts"
  );
  const throwSites = src
    .split("\n")
    .filter((line) => /^\s*"order_not_commissionable",\s*$/.test(line));
  check(
    "sólo DOS sitios TIRAN order_not_commissionable (approve + handleSettle) — el void no tira ninguno",
    throwSites.length === 2
  );
}

// 21 (Fase 3 · check 12) · summary-1099 agrupa por vendor EFECTIVO + zona horaria
{
  const src = read("src/api/admin/commissions/summary-1099/route.ts");
  check(
    "summary-1099 agrupa por vendor efectivo vía customer_vendor_link LATERAL",
    src.includes("COALESCE(r.qb_vendor_id, cvl.qb_vendor_id)") &&
      src.includes("LEFT JOIN LATERAL") &&
      src.includes("customer_vendor_link")
  );
  check(
    "summary-1099 convierte a zona horaria ANTES de extraer el año (AT TIME ZONE anidado dentro de EXTRACT(YEAR)",
    src.includes("EXTRACT(YEAR FROM (COALESCE(r.settled_at, s.updated_at) AT TIME ZONE $2)) = $1")
  );
}

// 22 (Fase 4 · check 13) · assertAccounting en los TRES handlers de la orden
{
  const src = read("src/api/admin/commissions/orders/[orderId]/route.ts");
  const calls = src.split("assertAccounting(req, res)").length - 1;
  check(
    "GET+POST+DELETE de orders/:orderId llaman assertAccounting(req,res) — 3 veces",
    calls === 3
  );
}

// 23 (Fase 4 · check 14) · el retry de los dos steps de comisión sigue
// protegido ANTES del UPDATE que reclama la fila (limpia bridge_op_id a NULL) —
// después sería inútil, el valor que necesita ya sería NULL.
//
// SUPERSEDED el 2026-08-18: la protección era un guard propio con el código
// `commission_retry_needs_qb_check`; ahora la provee el gate genérico
// `evaluateRetryGate` (lib/quickbooks/pipeline/retry-gate.ts), que cubre esos
// dos steps y ocho más. Este check pasó de buscar un STRING a comprobar el
// COMPORTAMIENTO: que el gate se consulte antes del claim, y que ejercitado con
// una fila de comisión ambigua efectivamente DENIEGUE. Un check atado al nombre
// de una implementación se rompe cuando la implementación mejora — y eso es
// exactamente lo que pasó acá.
{
  const src = read(
    "src/api/admin/quickbooks/pipeline/handlers/post-pipeline.ts"
  );
  const gateIdx = src.indexOf("evaluateRetryGate({");
  const claimIdx = src.indexOf("bridge_op_id = NULL,");
  check(
    "el retry gate se consulta ANTES del UPDATE que limpia bridge_op_id (el claim)",
    gateIdx >= 0 && claimIdx >= 0 && gateIdx < claimIdx
  );

  // Ejercitamos el gate REAL con las dos formas de fila de comisión que antes
  // cubría el guard propio: ADD en vuelo (bridge_op_id presente) con outcome
  // desconocido ⇒ tiene que denegar.
  for (const step of ["commission_check", "commission_payment"]) {
    const verdict = evaluateRetryGate({
      step,
      status: "failed",
      error:
        "Timed out before submitted state (>20 min) — no response from QB bridge",
      bridgeOpId: "op-verify",
      qbTxnId: null,
    });
    check(
      `el gate DENIEGA el retry de un ${step} con op en vuelo y outcome desconocido`,
      verdict.allow === false
    );
  }
}

// 24 (Fase 4 · check 15) · el botón/modal de Commissions del POS está
// gateado por showCommissions. El verificador vive en backend; resolvemos
// el path relativo al workspace y FALLAMOS con mensaje claro si no existe
// (nunca saltear en silencio).
{
  const rel = "../store-pos/app/(pos)/orders/[id]/page.tsx";
  let src: string | null = null;
  try {
    src = read(rel);
  } catch {
    src = null;
  }
  if (src === null) {
    check(`store-pos orders/[id]/page.tsx existe en ${rel} (resuelto desde ${ROOT})`, false);
  } else {
    const buttonGated = /\{order\.doc\.medusaId\s*&&\s*showCommissions\s*&&[\s\S]{0,60}Commissions/.test(
      src
    );
    const modalGated =
      /\{order\.doc\.medusaId\s*&&\s*showCommissions\s*&&[\s\S]{0,80}<CommissionsModal/.test(src);
    check(
      "store-pos: botón Y modal de Commissions gateados por showCommissions",
      src.includes("const showCommissions =") && buttonGated && modalGated
    );
  }
}

// 25 (2026-09-03) · devengo por PRIMER invoice — los DOS lectores.
//
// El MAX viejo reiniciaba la espera con cada factura parcial nueva. La regla
// vive en DOS queries (snapshot del devengo + listado); si divergen, la fecha
// del modal y la que aplica el refresh se contradicen en pantalla.
{
  const money = read("src/lib/commissions/order-money.ts");
  check(
    "order-money deriva first_invoice_at con MIN(created_at), no MAX",
    money.includes("MIN(created_at) AS first_invoice_at") && !money.includes("last_invoice_at")
  );
  const list = read("src/api/admin/commissions/route.ts");
  check(
    "el listado deriva first_invoice_at con MIN(pi.created_at), no MAX",
    list.includes("MIN(pi.created_at) AS first_invoice_at") && !list.includes("last_invoice_at")
  );
  check(
    "approval_ready_at del listado suma la espera sobre first_invoice_at",
    list.includes("inv.first_invoice_at + (c.wait_days || ' days')::interval")
  );
}

// 25b (2026-09-03, delta v4) · identidad EFECTIVA en el listado, en AMBAS
// direcciones. El vendor efectivo existe desde el 2026-08-15; el espejo
// (customer efectivo por el link inverso) faltó y el SettleModal deshabilitaba
// Store Credit para beneficiarios asignados por vendor con el link existiendo.
{
  const list = read("src/api/admin/commissions/route.ts");
  check(
    "el listado sirve customer EFECTIVO (COALESCE con el link inverso)",
    list.includes("COALESCE(r.customer_id, vcl.customer_id) AS customer_id")
  );
  check(
    "el link inverso resuelve por qb_vendor_id (lateral vcl)",
    /SELECT l\.customer_id FROM customer_vendor_link l\s+WHERE l\.qb_vendor_id = r\.qb_vendor_id AND l\.deleted_at IS NULL/.test(list)
  );
}

// 26 (2026-09-03) · approve TEMPRANO: sólo saltea la ESPERA, nunca el pago.
//
// canApproveEarly exige draft + eligible_at DETERMINADO (pago completo +
// factura). El writer sólo lo acepta con opt-in explícito del caller, y la
// ruta lo deriva de `early === true` — un typo en el body no puede abrirlo.
{
  const transitions = read("src/lib/commissions/transitions.ts");
  check(
    "canApproveEarly exige draft + eligible_at no-null",
    /current === "draft" && eligibleAt != null/.test(transitions)
  );
  const writer = read("src/lib/commissions/writer.ts");
  check(
    "approveRecipient sólo acepta early con opt-in explícito (allowEarly === true) + canApproveEarly",
    writer.includes("opts?.allowEarly === true && canApproveEarly(row.state, row.eligible_at)")
  );
  const route = read(
    "src/api/admin/commissions/orders/[orderId]/recipients/[recipientId]/route.ts"
  );
  check(
    "la ruta de approve deriva allowEarly de body.early === true (estricto)",
    route.includes("allowEarly: body.early === true")
  );
}

// 27 (2026-09-03, delta v5) · el VENDOR ESPEJO: las cuatro propiedades que lo
// hacen servir para lo único que existe.
//
// El camino store_credit obliga a un vendor porque el CheckAdd a su nombre es
// lo que hace que QuickBooks capture la comisión en el 1099 solo (§11.5). Eso
// pide que el vendor nazca 1099-elegible — el alta mandaba sólo `name` y el
// flag quedaba en null, así que la razón entera del diseño no se cumplía y
// nada lo decía. Los otros tres son el flujo alrededor: el nombre que se
// muestra tiene que ser el VIVO (la copia del link no se refresca nunca), el
// modal tiene que despertar del `waiting` solo, y un rename no puede llevar al
// espejo al nombre pelado de su customer (namespace compartido de QB, §3.7).
{
  const posApi = read("../store-pos/app/(pos)/accounting/commissions/_lib/api.ts");
  check(
    "el alta del vendor espejo lo marca 1099-elegible",
    /createCommissionVendor[\s\S]{0,600}?is_vendor_eligible_for_1099:\s*true/.test(posApi)
  );

  const linkRoute = read("src/api/admin/commissions/customer-vendor-link/route.ts");
  check(
    "el GET del link sirve el nombre VIVO del vendor (COALESCE), no la foto del alta",
    linkRoute.includes("COALESCE(v.full_name, l.vendor_full_name) AS vendor_full_name")
  );

  const settleModal = read(
    "../store-pos/app/(pos)/accounting/commissions/_components/SettleModal.tsx"
  );
  check(
    "el modal repolla mientras el vendor no confirmó en QB (y para en synced/error)",
    /refetchInterval:[\s\S]{0,400}?vendor_sync_status[\s\S]{0,200}?'synced'[\s\S]{0,60}?'error'/.test(
      settleModal
    )
  );

  // El guard del rename se afirma POR NOMBRE de ruta, no por lo que su texto
  // mencione: es exactamente la ceguera de §quinta extensión de secrets.md —
  // una ruta que debería validar y no nombra nada sale limpia de un barrido
  // por menciones. Y se exige el 409 ANTES del write local: el VendorMod corre
  // en background, así que validar después deja la fila local ya renombrada.
  const vendorPatch = read("src/api/admin/qb-catalog/vendors/[id]/route.ts");
  const guardAt = vendorPatch.indexOf("vendor_name_collides_with_customer");
  const writeAt = vendorPatch.indexOf("await catalog.updateQbVendors({\n    id,\n    ...updates,");
  check(
    "el PATCH del vendor rechaza el rename que colisiona con su customer linkeado",
    guardAt > -1 &&
      /FROM customer_vendor_link l\s+JOIN customer c/.test(vendorPatch) &&
      vendorPatch.includes("status(409)")
  );
  check(
    "ese rechazo ocurre ANTES de escribir la fila local",
    guardAt > -1 && writeAt > -1 && guardAt < writeAt
  );
  check(
    "el guard sólo mira RENAMES (compara contra el full_name actual), no toda edición",
    /canon\(renamedTo\) !== canon\(String\(vendor\.full_name/.test(vendorPatch)
  );
}

console.log("");
if (failures.length > 0) {
  console.error(`❌ ${failures.length} chequeo(s) fallaron:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("✅ verify-order-commissions: todo registrado.");
