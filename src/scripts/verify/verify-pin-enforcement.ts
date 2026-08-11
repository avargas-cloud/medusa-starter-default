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
 *   3. toda ruta del backend que hable de PIN usa el helper compartido, no una
 *      comparación a mano
 *   4. las 9 rutas de edición de orden llaman al guard de orden web
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

// ── 3 · el backend usa el helper compartido, no comparaciones a mano ─────────
const SHARED = /verifySupervisorPin|guardSupervisorPin/;
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
      `src/${rel} habla de supervisor_pin pero no usa el helper compartido. ` +
        `Si es una ruta gateada, tiene que verificar; si sólo reenvía el campo, ` +
        `no debería nombrarlo.`
    );
  }
  if (/(console\.[a-z]+|logger\.[a-z]+)\([^)]*supervisor_?[Pp]in/.test(src)) {
    failures.push(
      `src/${rel} loguea el PIN. Un valor logueado termina en transcripts, ` +
        `salidas de herramientas y servicios de terceros.`
    );
  }
}
notes.push(`✓ ${routesWithPin} archivo(s) de backend con PIN, todos por el helper`);

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
  if (!fs.readFileSync(p, "utf8").includes("assertWebOrderAuthorized")) {
    failures.push(
      `orders/[id]/${r} no llama a assertWebOrderAuthorized(). Una orden que ` +
        `vino de la web se editaría sin PIN por esa ruta.`
    );
  }
}
if (!failures.some((f) => f.includes("orders/[id]"))) {
  notes.push(`✓ las ${ORDER_EDIT_ROUTES.length} rutas de edición de orden gatean el origen web`);
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
const MUST_GATE_ROUTES = [
  ["api/admin/pos/prices/[productId]/route.ts", "escribe el precio retail y el wholesale de un ítem"],
  ["api/admin/quickbooks/bill-match/adopt/route.ts", "registra un bill de QuickBooks contra un PO"],
  ["api/admin/quickbooks/bill-match/undo/route.ts", "revierte un bill-match adoptado"],
  ["api/admin/quickbooks/customer-credits/import/route.ts", "importa un crédito de QB como saldo redimible"],
  ["api/admin/purchase-orders/[id]/factory-order-mirror/route.ts", "crea o sincroniza el Factory Order espejo de un PO"],
];
for (const [rel, what] of MUST_GATE_ROUTES) {
  const p = path.join(BACKEND_SRC, rel);
  if (!fs.existsSync(p)) {
    failures.push(
      `${rel} no existe donde se esperaba — si se movió o se renombró, ` +
        `actualizar esta lista: el gate se afirma por nombre y una ruta que se ` +
        `mueve deja de estar cubierta en silencio.`
    );
    continue;
  }
  if (!SHARED.test(stripComments(fs.readFileSync(p, "utf8")))) {
    failures.push(
      `${rel} ${what} y no llama a guardSupervisorPin(). Como todo cajero es un ` +
        `usuario admin, sin el gate cualquier token válido ejecuta la operación ` +
        `con un POST directo — el modal de la pantalla no autoriza nada.`
    );
  }
}
if (!failures.some((f) => MUST_GATE_ROUTES.some(([rel]) => f.startsWith(rel)))) {
  notes.push(`✓ las ${MUST_GATE_ROUTES.length} rutas de escritura de dinero llaman al guard`);
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

// ── Reporte ─────────────────────────────────────────────────────────────────
console.log("=== verify-pin-enforcement ===\n");
for (const n of notes) console.log("  " + n);

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} problema(s):\n`);
  for (const f of failures) console.error("  • " + f + "\n");
  process.exit(1);
}
console.log(`\n✅ el PIN sigue siendo una autorización real`);
