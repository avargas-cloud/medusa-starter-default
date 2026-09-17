/**
 * Verifica que el PIN de supervisor siga siendo una autorización REAL.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El PIN fue un cartel durante mucho tiempo sin que se notara: vivía en
 * `store.metadata`, viajaba al navegador dentro de la respuesta de
 * `/admin/stores`, y se comparaba en React. Legible con F12, salteable editando
 * el estado, y las rutas no lo pedían. Encima se podía CAMBIAR sin conocer el
 * anterior por la ruta nativa de Medusa, lo que volvía irrelevantes hasta los
 * gates que sí verificaban del lado del servidor.
 *
 * Nada de eso daba error, ni rompía un test, ni se veía distinto en pantalla —
 * un gate abierto y uno cerrado se ven EXACTAMENTE igual desde la UI. Por eso
 * este verificador existe: es la única cosa que puede notar la regresión antes
 * de que alguien la descubra usando el sistema.
 *
 * ── Qué chequea ───────────────────────────────────────────────────────────────
 *   1. store-pos no compara PINes en el navegador
 *   2. store-pos no lee el VALOR del PIN (sólo pregunta si hay uno configurado)
 *   3. toda ruta del backend que hable de PIN usa el GUARD compartido, no una
 *      comparación a mano
 *   3b. ninguna ruta llama a `verifySupervisorPin` pelado: sin throttle y sin
 *      el `confirm` de admin, un gate así rechaza siempre a la pantalla
 *   4. las 9 rutas de edición de orden llaman al guard de orden web
 *   4b. las rutas de escritura de dinero llaman al guard, se nombren o no al PIN
 *   4c. el frontend le MANDA el PIN a esas rutas (la falla inversa de 4b)
 *   5. la ruta nativa de stores sigue protegida por su middleware
 *   6. ninguna ruta loguea el PIN
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-pin-enforcement.ts
 */
import fs from "node:fs";
import path from "node:path";

const BACKEND_SRC = path.join(process.cwd(), "src");
const POS_ROOT = path.join(process.cwd(), "..", "store-pos");

const failures: string[] = [];
const notes: string[] = [];

/**
 * Saca comentarios antes de buscar.
 *
 * La primera versión de este verificador acusó a tres archivos por nombrar
 * `pos_supervisor_pin`... en un comentario que explicaba que ya NO lo leen. Un
 * verificador que grita por prosa se termina ignorando, y ahí deja de servir —
 * que es exactamente cómo el PIN llegó a ser un cartel sin que nadie lo notara.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // bloque
    .replace(/^\s*\/\/.*$/gm, " ") // línea completa
    .replace(/([^:"'`])\/\/.*$/gm, "$1"); // al final de una línea de código
}

function walk(dir: string, exts = [".ts", ".tsx"]): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".next", ".medusa", "dist"].includes(e.name)) continue;
      out.push(...walk(full, exts));
    } else if (exts.some((x) => e.name.endsWith(x))) {
      out.push(full);
    }
  }
  return out;
}

// ── 1 + 2 · el frontend no compara ni lee el PIN ─────────────────────────────
const posExists = fs.existsSync(POS_ROOT);
if (!posExists) {
  notes.push(
    "⏭️  store-pos no está en disco — los chequeos de frontend se omiten " +
      "(esperado en un deploy del backend solo)"
  );
} else {
  /** Comparar un PIN en el cliente. El PIN se manda; no se compara. */
  const CLIENT_COMPARE =
    /(===|!==)\s*(supervisorPin|storePin|pinFromStore)\b|\b(pin|pinInput|verifyPin)\s*(===|!==)\s*[^=\n]*supervisor/i;

  /**
   * Leer el VALOR. `pos_supervisor_pin` sólo puede aparecer del lado del
   * SERVIDOR; en el frontend, ni nombrado — para saber si existe hay endpoint.
   */
  const READS_VALUE = /pos_supervisor_pin/;

  for (const abs of walk(POS_ROOT)) {
    const rel = path.relative(POS_ROOT, abs);
    const src = stripComments(fs.readFileSync(abs, "utf8"));

    if (CLIENT_COMPARE.test(src)) {
      failures.push(
        `store-pos/${rel} compara un PIN en el NAVEGADOR. El PIN se manda al ` +
          `servidor (header x-supervisor-pin) y la ruta lo verifica — una ` +
          `comparación local es salteable editando el estado de React.`
      );
    }
    if (READS_VALUE.test(src)) {
      failures.push(
        `store-pos/${rel} nombra pos_supervisor_pin. El VALOR no puede viajar ` +
          `al navegador: se lee de una respuesta de la API con F12. Para saber ` +
          `si hay uno configurado, GET /admin/pos/supervisor-pin → {configured}.`
      );
    }
  }
  if (!failures.length) {
    notes.push("✓ store-pos no compara ni lee el valor del PIN");
  }
}

// ── 3 · el backend usa el GUARD compartido, no comparaciones a mano ──────────
// `assertWebOrderAuthorized` cuenta como guard: envuelve guardSupervisorPin
// con la resolución de origen web. Un archivo que sólo REENVÍA la credencial
// (post-edit-sync la pasa a sus self-calls) es legítimo únicamente si él mismo
// está gateado por uno de estos — si sólo la nombra sin gate, sigue fallando.
//
// `verifySupervisorPin` NO cuenta (2026-09-15): es el sí/no crudo que el guard
// envuelve. Cinco rutas lo usaban directo y por eso rechazaban el `confirm`
// literal de un admin —que sólo el guard acepta— y verificaban sin límite de
// intentos. Ver 3b, que lo prohíbe por LLAMADA en todo el backend.
const SHARED = /guardSupervisorPin|assertWebOrderAuthorized|withAccountingAndPin/;
/**
 * sales-tax-center-20260917: `withAccountingAndPin` es el delegado de las rutas
 * de Sales Tax (Accounting + PIN en un solo wrapper, `_lib/common.ts`). Cuenta
 * como guard SÓLO porque acá se afirma que su cuerpo llama a
 * `guardSupervisorPin(` — sin import, por LLAMADA — igual que 4b hace con las
 * rutas. Un delegado que dejara de llamarlo pondría rojo este chequeo antes
 * que a ninguna ruta.
 */
const PIN_DELEGATES: { fn: string; rel: string }[] = [
  { fn: "withAccountingAndPin", rel: "api/admin/accounting/sales-tax/_lib/common.ts" },
];
for (const { fn, rel } of PIN_DELEGATES) {
  const p = path.join(BACKEND_SRC, rel);
  if (!fs.existsSync(p)) {
    failures.push(`${rel} (delegado ${fn}) no existe — si se movió, actualizar PIN_DELEGATES.`);
    continue;
  }
  const bodyNoImports = stripComments(fs.readFileSync(p, "utf8"))
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*} from /.test(l))
    .join("\n");
  if (!/guardSupervisorPin\s*\(/.test(bodyNoImports)) {
    failures.push(
      `${rel}: ${fn}() cuenta como guard para las rutas que lo llaman, pero su ` +
        `cuerpo no llama a guardSupervisorPin(). Sin esa llamada las rutas de ` +
        `Sales Tax quedan sin PIN con este verificador en verde.`
    );
  }
}
/** Una comparación cruda contra la metadata es exactamente lo que no debe pasar. */
const HAND_ROLLED =
  /metadata(\?)?\.\[?["']?pos_supervisor_pin["']?\]?\s*(===|!==|==)/;

let routesWithPin = 0;
for (const abs of walk(BACKEND_SRC, [".ts"])) {
  const rel = path.relative(BACKEND_SRC, abs);
  if (rel.startsWith("scripts") || rel.startsWith("__tests__")) continue;
  const src = stripComments(fs.readFileSync(abs, "utf8"));
  const mentionsPin = /supervisor_pin|supervisorPin/.test(src);
  if (!mentionsPin) continue;
  // El helper y el guard son los dueños de la lógica — se saltean.
  if (rel.startsWith(path.join("lib", "pos"))) continue;
  // El middleware nombra la clave para RECHAZARLA por la ruta nativa. No
  // verifica nada y no debe: es un portazo, no una autorización.
  if (rel.endsWith(path.join("middlewares", "protect-supervisor-pin.ts"))) continue;

  routesWithPin++;
  if (HAND_ROLLED.test(src)) {
    failures.push(
      `src/${rel} compara el PIN a mano contra la metadata. Usar ` +
        `guardSupervisorPin() — trae el límite de intentos, y sin él mover la ` +
        `verificación al servidor sólo cambia "saberlo" por "adivinarlo".`
    );
  }
  if (!SHARED.test(src)) {
    failures.push(
      `src/${rel} habla de supervisor_pin pero no usa guardSupervisorPin() ni ` +
        `assertWebOrderAuthorized(). Si es una ruta gateada, tiene que ` +
        `verificar por el guard; si sólo reenvía el campo, no debería nombrarlo.`
    );
  }
  if (/(console\.[a-z]+|logger\.[a-z]+)\([^)]*supervisor_?[Pp]in/.test(src)) {
    failures.push(
      `src/${rel} loguea el PIN. Un valor logueado termina en transcripts, ` +
        `salidas de herramientas y servicios de terceros.`
    );
  }
}
notes.push(`✓ ${routesWithPin} archivo(s) de backend con PIN, todos por el guard`);

// ── 3b · nadie llama a verifySupervisorPin pelado ────────────────────────────
/**
 * `verifySupervisorPin` contesta sí/no y nada más. Todo lo que hace al PIN una
 * autorización real vive en `guardSupervisorPin`: el límite de intentos (sin
 * él, 4 dígitos son 10.000 intentos en segundos) y el `confirm` literal que un
 * admin escribe en vez del PIN. Una ruta que salta el guard pierde las dos
 * cosas a la vez, y la segunda se nota como función ROTA: SupervisorPinModal
 * manda `confirm` para un admin, la comparación cruda lo toma como PIN
 * equivocado, y la pantalla contesta 403 (o reabre el modal en loop) sin que
 * nada en verde lo diga. Así vivieron el PATCH de un bill con wire confirmado,
 * el edit de un credit memo de otro día, el revert y el confirm-cleanup de un
 * refund, y el cambio del PIN mismo.
 *
 * Se barre TODO el backend, no sólo los archivos que nombran `supervisor_pin`:
 * el cambio de PIN pasaba `current_pin`, y un chequeo que dependa de que el
 * archivo se acuerde de nombrar la clave es el defecto que 4b ya documentó.
 * Por LLAMADA y sin imports ni comentarios, como los demás.
 */
const BARE_VERIFY_CALL = /\bverifySupervisorPin\s*\(/;
let bareVerifyCalls = 0;
for (const abs of walk(BACKEND_SRC, [".ts"])) {
  const rel = path.relative(BACKEND_SRC, abs);
  if (rel.startsWith("scripts") || rel.startsWith("__tests__")) continue;
  // Los dos dueños: el que lo define y el guard que lo envuelve.
  if (rel.startsWith(path.join("lib", "pos"))) continue;
  const bodyNoImports = stripComments(fs.readFileSync(abs, "utf8"))
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*} from /.test(l))
    .join("\n");
  if (BARE_VERIFY_CALL.test(bodyNoImports)) {
    bareVerifyCalls++;
    failures.push(
      `src/${rel} llama a verifySupervisorPin() directo. Usar ` +
        `guardSupervisorPin(): sin él no hay límite de intentos y el ` +
        `\`confirm\` de un admin cuenta como PIN equivocado — la pantalla ` +
        `recibe 403 siempre y quema el throttle del operador.`
    );
  }
}
if (bareVerifyCalls === 0) {
  notes.push("✓ ninguna ruta llama a verifySupervisorPin() pelado");
}

// ── 4 · las 9 rutas de edición de orden llaman al guard de orden web ────────
const ORDER_EDIT_ROUTES = [
  "add-item-force",
  "add-shipping-force",
  "apply-discount-force",
  "delete-item-force",
  "post-edit-sync",
  "revert-to-draft",
  "update-force",
  "update-item-force",
  "update-shipping-force",
];
for (const r of ORDER_EDIT_ROUTES) {
  const p = path.join(BACKEND_SRC, "api/admin/orders/[id]", r, "route.ts");
  if (!fs.existsSync(p)) {
    failures.push(
      `la ruta de edición ${r} no existe donde se esperaba — si se movió o se ` +
        `renombró, actualizar esta lista, porque el gate de orden web se aplica ` +
        `por nombre.`
    );
    continue;
  }
  // La LLAMADA, no la mención: un import huérfano dejaba pasar el check
  // (mutation test 2026-08-14). Se descartan las líneas import primero.
  const bodyNoImports = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*} from /.test(l))
    .join("\n");
  if (!/assertWebOrderAuthorized\s*\(/.test(bodyNoImports)) {
    failures.push(
      `orders/[id]/${r} no llama a assertWebOrderAuthorized(). Una orden que ` +
        `vino de la web se editaría sin PIN por esa ruta.`
    );
  }
}
if (!failures.some((f) => f.includes("orders/[id]"))) {
  notes.push(`✓ las ${ORDER_EDIT_ROUTES.length} rutas de edición de orden gatean el origen web`);
}

// ── 4a · efectos financieros FUERA de orders/[id] también gatean origen web ──
//
// Devolver plata o mover inventario de una orden web es editar el contrato del
// cliente aunque la ruta viva bajo customer-payments o credit_memos. Se
// afirman por NOMBRE (misma razón que 4b) y resuelven la(s) orden(es) del
// documento vía assertWebOrdersAuthorized.
const WEB_MONEY_ROUTES = [
  ["api/admin/customer-payments/[id]/refund/route.ts", "refund de un pago"],
  ["api/admin/pos/credit_memos/[id]/complete/route.ts", "completa un credit memo (dinero+inventario+QB)"],
  ["api/admin/pos/credit_memos/[id]/edit/route.ts", "edita un credit memo completado"],
  ["api/admin/pos/credit_memos/[id]/void/route.ts", "voidea un credit memo"],
  ["api/admin/pos/credit_memos/[id]/damaged/route.ts", "marca items damaged (inventario)"],
];
for (const [rel, what] of WEB_MONEY_ROUTES) {
  const p = path.join(BACKEND_SRC, rel);
  if (!fs.existsSync(p)) {
    failures.push(
      `${rel} no existe donde se esperaba — si se movió, actualizar esta ` +
        `lista: el gate web se afirma por nombre.`
    );
    continue;
  }
  // La LLAMADA, no la mención — un import huérfano no gatea nada.
  const finBodyNoImports = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*} from /.test(l))
    .join("\n");
  if (!/assertWebOrdersAuthorized\s*\(/.test(finBodyNoImports)) {
    failures.push(
      `${rel} ${what} y no llama a assertWebOrdersAuthorized() — sobre una ` +
        `orden web ese dinero se movería sin PIN.`
    );
  }
}
if (!failures.some((f) => WEB_MONEY_ROUTES.some(([rel]) => f.includes(rel)))) {
  notes.push(
    `✓ las ${WEB_MONEY_ROUTES.length} rutas financieras gatean el origen web`
  );
}

// ── 4b · rutas que DEBEN gatear, se nombren o no al PIN ──────────────────────
/**
 * El chequeo 3 audita los archivos que MENCIONAN el PIN: garantiza que ninguno
 * lo haga a mano, pero es ciego a la falla inversa — una ruta que debería pedir
 * PIN y no dice nada nunca entra en su barrido, así que sale limpia.
 *
 * Así vivió `pos/prices/[productId]` sin NINGUNA autorización de servidor: su
 * único gate era una comparación en React, y el verificador no tenía por qué
 * mirarla. El agujero salió por el chequeo del frontend (el modal leía el
 * valor), no por acá.
 *
 * Por eso estas rutas se afirman por NOMBRE, igual que las 9 de edición de
 * orden: son escrituras de dinero cuyo gate no puede depender de que el archivo
 * se acuerde de nombrar la clave.
 */
/**
 * `noFrontendCaller` documenta, por ruta, que NINGUNA pantalla la llama. Existe
 * porque el chequeo 4c exige encontrar al menos un callsite —si no, un regex
 * roto pasaría en vacío— y una ruta sin caller haría fallar esa exigencia por el
 * motivo equivocado. El texto tiene que decir POR QUÉ no lo tiene: una ruta que
 * se quedó sin pantalla es deuda, no una propiedad del diseño.
 */
const MUST_GATE_ROUTES: {
  rel: string;
  what: string;
  noFrontendCaller?: string;
  fieldGated?: string;
}[] = [
  {
    rel: "api/admin/pos/prices/[productId]/route.ts",
    what: "escribe el precio retail y el wholesale de un ítem",
  },
  {
    rel: "api/admin/reports/profit-loss/payroll/route.ts",
    what: "escribe el costo de nómina mensual manual que baja la utilidad del P&L",
  },
  {
    rel: "api/admin/pos/products/[id]/route.ts",
    what:
      "escribe discontinued, el Product Source (USA/CHINA) y el retail_price " +
      "que viaja a QuickBooks como SalesPrice",
    fieldGated:
      "el gate es POR CAMPO: por esta misma ruta pasan el Save normal del modal " +
      "(título, SKU, peso) y la propagación de costo del editor de PO y de la " +
      "página de vendor bill, que NO piden PIN. Exigirle el PIN a todo callsite " +
      "rompería esos tres flujos",
  },
  // ap-rounding-cleanup-20260916: las tres rutas del carril de ajuste AP
  // escriben lo que el POS dice que se le debe a un proveedor.
  {
    rel: "api/admin/accounting/payables/write-off-rounding/route.ts",
    what: "salda en lote los residuos de centavos de bills que QuickBooks tiene pagados (Dr AP)",
  },
  {
    rel: "api/admin/vendor-bills/[id]/adjustments/route.ts",
    what: "crea un ajuste de redondeo o de variación de precio sobre un bill (mueve AP)",
    noFrontendCaller:
      "lo llaman los scripts de limpieza y el POST manual con PIN; la pantalla " +
      "de bill sólo LISTA los ajustes (GET) — crear uno a mano desde la UI es " +
      "deuda declarada del plan ap-rounding-cleanup-20260916",
  },
  {
    rel: "api/admin/vendor-bills/[id]/adjustments/[adjustmentId]/void/route.ts",
    what: "voidea un ajuste (devuelve el residuo al bill, reversa el GL)",
    noFrontendCaller: "misma deuda que la ruta de creación: sin pantalla todavía",
  },
  // `api/admin/pos/prices/bulk/route.ts` se BORRÓ el 2026-08-19. Estaba gateada
  // igual que las demás, pero no la llamaba ninguna pantalla desde que el editor
  // masivo pasó al flujo de price-batches, y era una segunda forma de repreciar
  // 500 ítems sin dejar el PA-#### que el approve sí registra. Su `_lib/` sigue
  // vivo: lo importan cuatro rutas de price-batches.
  {
    rel: "api/admin/pos/price-batches/[id]/approve/route.ts",
    what: "applies an approved price-change batch's cost/retail/wholesale changes",
  },
  // Conteos de inventario (2026-09-12): aprobar mueve stock y encola el ajuste
  // a QuickBooks; voidear lo revierte y manda un TxnVoid. `requireManager`
  // dice QUIÉN puede; el PIN dice que un supervisor lo autorizó. Reject no
  // gatea. Callsite del POS: `lib/api/inventory-counts.ts` (URL literal a
  // propósito, para que §4c la vea).
  {
    rel: "api/admin/inventory-counts/[id]/approve/route.ts",
    what: "aplica los deltas de un conteo al stock y los encola a QuickBooks",
  },
  {
    rel: "api/admin/inventory-counts/[id]/void/route.ts",
    what: "revierte los deltas de un conteo aprobado y voidea el ajuste en QuickBooks",
  },
  {
    rel: "api/admin/quickbooks/bill-match/adopt/route.ts",
    what: "registra un bill de QuickBooks contra un PO",
  },
  {
    rel: "api/admin/quickbooks/bill-match/undo/route.ts",
    what: "revierte un bill-match adoptado",
  },
  {
    rel: "api/admin/quickbooks/customer-credits/import/route.ts",
    what: "importa un crédito de QB como saldo redimible",
  },
  {
    rel: "api/admin/purchase-orders/[id]/factory-order-mirror/route.ts",
    what: "crea o sincroniza el Factory Order espejo de un PO",
  },
  // "Manage connections" del panel de Banking. No mueven plata por sí solas,
  // pero deciden de qué banco entra el feed, qué cuentas se ven, contra qué
  // cuenta de QuickBooks se mapea cada una, desde cuándo y con qué saldo de
  // apertura arranca la revisión, y quién puede revisar, cerrar el día y
  // postear. Todo eso es la base de la contabilidad que sí mueve plata, y
  // `reviewAccess(req, "manage")` sólo dice QUIÉN administra: como todo cajero
  // es usuario admin, sin PIN cualquiera de esos cambios sale con un POST.
  {
    rel: "api/admin/banking/accounts/[id]/route.ts",
    what: "mapea la cuenta bancaria contra una cuenta de QuickBooks",
  },
  {
    rel: "api/admin/banking/accounts/[id]/setup/route.ts",
    what: "fija la fecha de inicio de revisión y el saldo de apertura de la cuenta",
  },
  {
    rel: "api/admin/banking/permissions/route.ts",
    what: "otorga permisos de revisión, cierre diario y posteo contable",
  },
  {
    rel: "api/admin/banking/connections/[id]/reconnect/route.ts",
    what: "reconecta un banco y reanuda el feed automático",
  },
  {
    rel: "api/admin/banking/connections/[id]/accounts/route.ts",
    what: "elige qué cuentas de la conexión se muestran y se sincronizan",
  },
  {
    rel: "api/admin/banking/connections/[id]/disconnect/route.ts",
    what: "desconecta el banco y corta las actualizaciones automáticas",
  },
  // "Request update" (2026-09-16): cada banco seleccionado es un
  // /transactions/refresh FACTURADO por Plaid ($0.12). El permiso de manage
  // dice quién ve el botón; el PIN es el control del GASTO — y la ruta además
  // rechaza el banco cuyo dato ya es de hoy, para que un checkbox deshabilitado
  // no sea la única barrera. Un callsite: `RequestUpdateModal.tsx`, por header.
  {
    rel: "api/admin/banking/connections/refresh/route.ts",
    what: "dispara refreshes pagos de Plaid para los bancos seleccionados",
  },
  // Revertir un refund devuelve la plata al cliente como crédito usable y
  // toca QB (TxnDel del $0 apply + TxnVoid del check); confirm-qb-cleanup es
  // la ATESTACIÓN de que el contador ya limpió QB a mano y completa ese mismo
  // revert. `assertAccounting` dice QUIÉN; el PIN dice que alguien lo
  // autorizó. Un solo callsite: `components/pos/RevertRefundModal.tsx`, por
  // body.
  {
    rel: "api/admin/finance/qb-refunds/[id]/revert/route.ts",
    what: "revierte un refund registrado y devuelve el dinero como crédito",
  },
  {
    rel: "api/admin/finance/qb-refunds/[id]/confirm-qb-cleanup/route.ts",
    what: "completa un revert atestando que QuickBooks ya se limpió a mano",
  },
  {
    rel: "api/admin/reports/sales/revenue-baseline/route.ts",
    what:
      "escribe el baseline manual que se SUMA al gráfico anual de ventas — un " +
      "número tipeado a mano que después se lee como si fuera facturación",
  },
  // Sales Tax Center (2026-09-17): pagar y ajustar el sales tax mueven el
  // payable y van a QuickBooks (SalesTaxPaymentCheckAdd / JournalEntryAdd con
  // el vendor del DOR); anular reversa y manda TxnVoid; Settings decide contra
  // qué ítem, vendor y banco sale la plata; reopen deshace una declaración
  // registrada. `assertAccounting` dice QUIÉN; el PIN, que alguien lo autorizó.
  // Callsites del POS: `lib/sales-tax/api.ts`, por header.
  {
    rel: "api/admin/accounting/sales-tax/payments/route.ts",
    what: "registra un pago de sales tax (Dr payable / Cr banco) y lo manda a QuickBooks",
  },
  {
    rel: "api/admin/accounting/sales-tax/payments/[id]/void/route.ts",
    what: "anula un pago de sales tax (reversa + TxnVoid SalesTaxPaymentCheck)",
  },
  {
    rel: "api/admin/accounting/sales-tax/adjustments/route.ts",
    what: "crea un ajuste de sales tax due (allowance, penalty, interest…) que mueve el payable",
  },
  {
    rel: "api/admin/accounting/sales-tax/adjustments/[id]/void/route.ts",
    what: "anula un ajuste de sales tax (reversa + TxnVoid JournalEntry)",
  },
  {
    rel: "api/admin/accounting/sales-tax/settings/route.ts",
    what: "cambia el tax item, el vendor del DOR y el banco default de los pagos de sales tax",
  },
  {
    rel: "api/admin/accounting/sales-tax/periods/[period]/reopen/route.ts",
    what: "reabre una declaración preparada o registrada como presentada",
  },
];
for (const { rel, what } of MUST_GATE_ROUTES) {
  const p = path.join(BACKEND_SRC, rel);
  if (!fs.existsSync(p)) {
    failures.push(
      `${rel} no existe donde se esperaba — si se movió o se renombró, ` +
        `actualizar esta lista: el gate se afirma por nombre y una ruta que se ` +
        `mueve deja de estar cubierta en silencio.`
    );
    continue;
  }
  // La LLAMADA, no la mención. Este chequeo probaba `SHARED` contra el archivo
  // entero, así que el IMPORT del guard ya lo daba por cumplido: al
  // mutation-testear el gate nuevo de products/:id —reemplazando la llamada y
  // dejando el import— el verificador siguió en verde. Mismo defecto que 4a ya
  // tenía documentado y arreglado; acá había quedado sin aplicar.
  const bodyNoImports = stripComments(fs.readFileSync(p, "utf8"))
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*} from /.test(l))
    .join("\n");
  // `verifySupervisorPin` no alcanza (ver 3b): el gate es el guard — o uno de
  // los delegados de PIN_DELEGATES, cuyo cuerpo ya se afirmó arriba.
  if (!/(guardSupervisorPin|assertWebOrderAuthorized|withAccountingAndPin)\s*\(/.test(bodyNoImports)) {
    failures.push(
      `${rel} ${what} y no llama a guardSupervisorPin(). Como todo cajero es un ` +
        `usuario admin, sin el gate cualquier token válido ejecuta la operación ` +
        `con un POST directo — el modal de la pantalla no autoriza nada.`
    );
  }
}
if (!failures.some((f) => MUST_GATE_ROUTES.some(({ rel }) => f.startsWith(rel)))) {
  notes.push(`✓ las ${MUST_GATE_ROUTES.length} rutas de escritura de dinero llaman al guard`);
}

// ── 4c · el frontend le MANDA el PIN a esas rutas ────────────────────────────
/**
 * La falla inversa del chequeo 4b, y la que este archivo no podía ver.
 *
 * 4b garantiza que la ruta PIDA el PIN. Nada garantizaba que la pantalla lo
 * MANDE — y una ruta gateada cuyo frontend nunca manda nada no es insegura: es
 * una función rota que nadie puede usar, con el agravante de que cada intento
 * quema un intento del throttle (8 / 15 min por USUARIO) y termina bloqueando al
 * operador para todas las demás operaciones con PIN.
 *
 * Pasó exactamente eso: `EditItemModalAdmin` dejaba Retail y Wholesale editables
 * sin candado y posteaba a `pos/prices/:id` sin el header, así que TODO cambio de
 * precio desde el modal de admin moría en 403 — meses, en producción, con el
 * type-check, el lint y los seis chequeos de este verificador en verde. El modal
 * de la rama `pos_user` sí lo mandaba, así que el defecto sólo lo veían los
 * admins, que son todos los cajeros.
 *
 * Cómo se afirma: se deriva la ruta HTTP del path del archivo (los segmentos
 * dinámicos `[x]` se buscan como interpolación `${…}`, que es como los escribe
 * todo callsite), se ubica la llamada a `medusaFetch` que la contiene y se exige
 * `supervisorPin` DENTRO de esa llamada — no en el archivo, que volvería a pasar
 * por vecindad como pasaba con el import huérfano del chequeo 4a.
 *
 * Límite conocido: un callsite que arme la URL en una variable no se ve. Por eso
 * el chequeo también EXIGE encontrar al menos un callsite por ruta: sin eso, un
 * regex que dejara de matchear pasaría en vacío, que es la forma en que un gate
 * se apaga sin que nadie se entere.
 */
if (posExists) {
  /**
   * Wrappers de cliente que ponen el header `x-supervisor-pin`.
   *
   * `medusaFetch` es el crudo y lleva la URL completa. Los módulos con prefijo
   * propio la envuelven: `bankingPost('/permissions', …)` termina pegándole a
   * `/admin/banking/permissions`, así que en el callsite la ruta aparece SIN su
   * prefijo y con el método implícito en el nombre de la función — buscar el
   * path completo ahí no encuentra nada y el chequeo pasaría en vacío, que es
   * exactamente la forma en que un gate se apaga sin que nadie se entere.
   *
   * `strict` marca al wrapper que además DENUNCIA las apariciones del path que
   * no estén dentro de una llamada suya: con la URL completa escrita a mano, un
   * `fetch` pelado no tiene dónde poner el header. Para los wrappers con
   * prefijo no aplica, porque su path recortado también matchea llamadas de sus
   * hermanos de lectura (`bankingGet`), que no gatean nada.
   */
  const CLIENT_WRAPPERS: {
    fn: string;
    prefix: string;
    method: string | null;
    strict: boolean;
  }[] = [
    { fn: "medusaFetch", prefix: "", method: null, strict: true },
    {
      fn: "bankingPost",
      prefix: "/admin/banking",
      method: "POST",
      strict: false,
    },
  ];

  /**
   * `api/admin/pos/prices/[productId]/route.ts` → /\/admin\/pos\/prices\/\$\{[^}]+\}/
   *
   * Con `prefix`, devuelve el path recortado que escribe el wrapper — o `null`
   * si la ruta no vive bajo ese prefijo y por lo tanto ese wrapper no la puede
   * llamar.
   */
  function routeToPathRegex(rel: string, prefix: string): RegExp | null {
    const full = rel.replace(/^api/, "").replace(/\/route\.ts$/, "");
    if (prefix && !full.startsWith(`${prefix}/`)) return null;
    const httpPath = prefix ? full.slice(prefix.length) : full;
    const source = httpPath
      .split("/")
      .map((seg) =>
        /^\[.+\]$/.test(seg)
          ? "\\$\\{[^}]+\\}"
          : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
      .join("/");
    return new RegExp(source, "g");
  }

  /**
   * Devuelve el texto de la llamada a `fn` que CONTIENE `idx`.
   *
   * Cuenta paréntesis salteando strings, que es lo mínimo para no cortar la
   * llamada en un `)` que vive adentro de un template literal.
   *
   * La containment check no es cosmética: sin ella, el `lastIndexOf` puede
   * enganchar el nombre del wrapper en una LÍNEA DE IMPORT y devolver la
   * primera llamada que venga después —cualquier cosa, un `useState(false)`—
   * como si fuera el callsite. Ese falso callsite no manda el PIN, así que el
   * chequeo acusaría a una pantalla que hace todo bien.
   */
  function enclosingCall(src: string, idx: number, fn: string): string | null {
    const before = src.lastIndexOf(fn, idx);
    if (before === -1 || idx - before > 400) return null;
    const open = src.indexOf("(", before);
    if (open === -1 || open > idx) return null;
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        quote = c;
        continue;
      }
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) return i > idx ? src.slice(open, i + 1) : null;
      }
    }
    return null;
  }

  const posSources = walk(POS_ROOT).map((f) => ({
    file: f,
    src: stripComments(fs.readFileSync(f, "utf8")),
  }));

  for (const { rel, what, noFrontendCaller, fieldGated } of MUST_GATE_ROUTES) {
    if (fieldGated) {
      notes.push(`⏭️  ${rel}: gate por campo, no por ruta — ${fieldGated}`);
      continue;
    }
    let callsites = 0;
    let missing = 0;
    let viaBody = 0;
    for (const wrapper of CLIENT_WRAPPERS) {
      const re = routeToPathRegex(rel, wrapper.prefix);
      if (!re) continue;
      for (const { file, src } of posSources) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const call = enclosingCall(src, m.index, wrapper.fn);
          if (!call) {
            if (!wrapper.strict) continue;
            failures.push(
              `${path.relative(POS_ROOT, file)} le pega a ${rel} fuera de ` +
                `${wrapper.fn}(): el PIN viaja en el header y este wrapper es el ` +
                `único lugar que lo pone.`
            );
            continue;
          }
          // El guard vive en el handler que MUTA. `medusaFetch` sin `method` es un
          // GET, y varias de estas rutas exponen un GET de lectura al lado del POST
          // gateado (el mirror PO→FO, sin ir más lejos): exigirle PIN a esa lectura
          // sería el verificador inventando una regla que el backend no tiene. Un
          // wrapper con método fijo en el nombre (`bankingPost`) lo declara.
          const method =
            wrapper.method ??
            /method\s*:\s*['"`](\w+)['"`]/.exec(call)?.[1] ??
            "GET";
          if (method.toUpperCase() === "GET") continue;

          callsites++;
          // Dos formas válidas, porque el guard del backend acepta las dos:
          //   · header  → `supervisorPin` en las opciones de medusaFetch (fuerte:
          //     se ve en la llamada misma). Se busca el identificador pelado, no
          //     `supervisorPin:` — el shorthand de ES6 es la forma más común y
          //     exigir los dos puntos daba un falso positivo en el mirror PO→FO.
          //   · body    → `supervisor_pin` como campo del payload (más débil: el
          //     payload se arma en otro lado, así que lo único que se puede
          //     afirmar es que el ARCHIVO lo maneja)
          if (/\bsupervisorPin\b/.test(call)) continue;
          if (/supervisor_pin/.test(src)) {
            viaBody++;
            continue;
          }
          missing++;
          failures.push(
            `${path.relative(POS_ROOT, file)} llama a ${rel} (${what}) sin ` +
              `mandar el PIN por ninguna de las dos vías (header supervisorPin ` +
              `ni campo supervisor_pin en el body). Esa ruta exige PIN, así que ` +
              `el llamado contesta 403 SIEMPRE y encima quema un intento del ` +
              `throttle — la operación queda imposible de hacer desde la pantalla.`
          );
        }
      }
    }
    if (callsites === 0 && !noFrontendCaller) {
      failures.push(
        `no se encontró ningún callsite de ${rel} en store-pos. O la pantalla ` +
          `que la usa dejó de existir, o la URL se arma de una forma que este ` +
          `chequeo no ve — en los dos casos el chequeo estaría pasando en vacío. ` +
          `Si de verdad no tiene pantalla, declararlo con noFrontendCaller y su ` +
          `motivo.`
      );
    } else if (callsites === 0) {
      notes.push(`⏭️  ${rel}: sin pantalla que la llame — ${noFrontendCaller}`);
    } else if (missing === 0) {
      notes.push(
        `✓ ${rel}: ${callsites} callsite(s) mandan el PIN` +
          (viaBody ? ` (${viaBody} por body, no por header)` : "")
      );
    }
  }
}

// ── 5 · la ruta nativa de stores sigue protegida ─────────────────────────────
const mw = path.join(BACKEND_SRC, "api/middlewares.ts");
const mwSrc = fs.existsSync(mw) ? fs.readFileSync(mw, "utf8") : "";
if (!mwSrc.includes("protectSupervisorPin")) {
  failures.push(
    `middlewares.ts no registra protectSupervisorPin. Sin él, cualquier cajero ` +
      `(todos son usuarios admin) cambia el PIN por POST /admin/stores/:id sin ` +
      `conocer el anterior — y con eso se pasa TODOS los demás gates.`
  );
} else if (!/matcher:\s*["']\/admin\/stores/.test(mwSrc)) {
  failures.push(
    `protectSupervisorPin está importado pero no matchea /admin/stores.`
  );
} else {
  notes.push("✓ la ruta nativa de stores rechaza escrituras del PIN");
}

// ── 6 · la ruta nativa de ORDERS gatea campos de contrato en órdenes web ─────
//
// Misma clase de agujero que el PIN por /admin/stores/:id: POST /admin/orders/:id
// acepta cualquier metadata, y por ahí viajaban las claves de descuento SIN
// pasar por assertWebOrderAuthorized. El POS dejó de mandarlas por la nativa
// (las persiste post-edit-sync, ruta gateada) y el middleware exige PIN si un
// request toca campos de contrato de una orden web.
{
  const mwFile = path.join(
    BACKEND_SRC,
    "api/middlewares/protect-web-order-fields.ts"
  );
  if (!fs.existsSync(mwFile)) {
    failures.push(
      `api/middlewares/protect-web-order-fields.ts no existe — la ruta nativa ` +
        `POST /admin/orders/:id vuelve a aceptar el descuento de una orden web ` +
        `sin PIN.`
    );
  } else {
    const mwFileSrc = stripComments(fs.readFileSync(mwFile, "utf8"));
    for (const key of ["discount_type", "discount_value", "promotion_code"]) {
      if (!mwFileSrc.includes(`"${key}"`)) {
        failures.push(
          `protect-web-order-fields.ts no lista "${key}" entre los campos ` +
            `protegidos — esa clave vuelve a escribirse por la nativa sin PIN.`
        );
      }
    }
    if (!mwFileSrc.includes("assertWebOrderAuthorized")) {
      failures.push(
        `protect-web-order-fields.ts no llama a assertWebOrderAuthorized() — ` +
          `un middleware que no resuelve el origen no gatea nada.`
      );
    }
  }
  if (
    !mwSrc.includes("protectWebOrderFields") ||
    !/matcher:\s*["']\/admin\/orders\/:id["']/.test(mwSrc)
  ) {
    failures.push(
      `middlewares.ts no registra protectWebOrderFields sobre /admin/orders/:id.`
    );
  }
  const pes = path.join(
    BACKEND_SRC,
    "api/admin/orders/[id]/post-edit-sync/route.ts"
  );
  const pesSrc = fs.existsSync(pes)
    ? stripComments(fs.readFileSync(pes, "utf8"))
    : "";
  // La ASIGNACIÓN al header de los self-calls, no la mera mención: el mutation
  // test demostró que extraer el header sin reenviarlo pasaba el check viejo.
  if (!/authHeaders\[["']x-supervisor-pin["']\]\s*=/.test(pesSrc)) {
    failures.push(
      `post-edit-sync no reenvía x-supervisor-pin a sus self-calls — en una ` +
        `orden web, apply-discount-force rechaza el descuento y el padre sigue ` +
        `de largo hacia la rama de recovery.`
    );
  }
  if (!failures.some((f) => f.includes("protect-web-order-fields") || f.includes("protectWebOrderFields") || f.includes("post-edit-sync no reenvía"))) {
    notes.push(
      "✓ la ruta nativa de orders gatea campos de contrato en órdenes web"
    );
  }
}

// ── Reporte ─────────────────────────────────────────────────────────────────
console.log("=== verify-pin-enforcement ===\n");
for (const n of notes) console.log("  " + n);

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} problema(s):\n`);
  for (const f of failures) console.error("  • " + f + "\n");
  process.exit(1);
}
console.log(`\n✅ el PIN sigue siendo una autorización real`);
