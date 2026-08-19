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

// ── 3 · el backend usa el helper compartido, no comparaciones a mano ─────────
// `assertWebOrderAuthorized` cuenta como helper: envuelve guardSupervisorPin
// con la resolución de origen web. Un archivo que sólo REENVÍA la credencial
// (post-edit-sync la pasa a sus self-calls) es legítimo únicamente si él mismo
// está gateado por uno de estos — si sólo la nombra sin gate, sigue fallando.
const SHARED =
  /verifySupervisorPin|guardSupervisorPin|assertWebOrderAuthorized/;
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
  {
    rel: "api/admin/pos/prices/bulk/route.ts",
    what: "bulk price/cost editor",
    noFrontendCaller:
      "el editor masivo pasó al flujo de price-batches (draft → submit → " +
      "approve) y esta ruta quedó sin pantalla; su motor vive en " +
      "lib/pos/apply-price-rows.ts, que sí usa el flujo nuevo",
  },
  {
    rel: "api/admin/pos/price-batches/[id]/approve/route.ts",
    what: "applies an approved price-change batch's cost/retail/wholesale changes",
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
  if (!/(verifySupervisorPin|guardSupervisorPin|assertWebOrderAuthorized)\s*\(/.test(bodyNoImports)) {
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
  /** `api/admin/pos/prices/[productId]/route.ts` → /\/admin\/pos\/prices\/\$\{[^}]+\}/ */
  function routeToPathRegex(rel: string): RegExp {
    const httpPath = rel.replace(/^api/, "").replace(/\/route\.ts$/, "");
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
   * Devuelve el texto de la llamada a `medusaFetch` que contiene `idx`.
   *
   * Cuenta paréntesis salteando strings, que es lo mínimo para no cortar la
   * llamada en un `)` que vive adentro de un template literal.
   */
  function enclosingFetchCall(src: string, idx: number): string | null {
    const before = src.lastIndexOf("medusaFetch", idx);
    if (before === -1 || idx - before > 400) return null;
    const open = src.indexOf("(", before);
    if (open === -1) return null;
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
        if (depth === 0) return src.slice(open, i + 1);
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
    const re = routeToPathRegex(rel);
    let callsites = 0;
    let missing = 0;
    let viaBody = 0;
    for (const { file, src } of posSources) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const call = enclosingFetchCall(src, m.index);
        if (!call) {
          failures.push(
            `${path.relative(POS_ROOT, file)} le pega a ${rel} fuera de ` +
              `medusaFetch(): el PIN viaja en el header y este wrapper es el ` +
              `único lugar que lo pone.`
          );
          continue;
        }
        // El guard vive en el handler que MUTA. `medusaFetch` sin `method` es un
        // GET, y varias de estas rutas exponen un GET de lectura al lado del POST
        // gateado (el mirror PO→FO, sin ir más lejos): exigirle PIN a esa lectura
        // sería el verificador inventando una regla que el backend no tiene.
        const method = /method\s*:\s*['"`](\w+)['"`]/.exec(call)?.[1] ?? "GET";
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
