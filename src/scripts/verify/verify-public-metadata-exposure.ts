/**
 * verify-public-metadata-exposure.ts
 *
 * Afirma que ninguna ruta pública de catálogo devuelve `product.metadata` sin
 * filtrar por el allowlist de `lib/product-metadata/public-keys.ts`.
 *
 * ## Qué falla esto
 *
 * Las cuatro rutas de `/store/products*` pedían `"metadata"` a `query.graph` y
 * devolvían el producto entero. Medido contra la base de PRODUCCIÓN el
 * 2026-09-05, eso publicaba `vendor_full_name` en 2.222 productos y las cuentas
 * contables de QuickBooks en 2.224 — o sea, de qué proveedor sale cada SKU, a
 * disposición de cualquiera con la publishable key (que viaja en el bundle del
 * storefront y es pública por diseño).
 *
 * ## Las dos mitades
 *
 * §A afirma que el allowlist no contiene nada sensible. §B afirma que TODA ruta
 * bajo `src/api/store/products/**` que PIDA metadata también la FILTRA — por
 * enumeración del árbol, no por una lista escrita a mano: una ruta nueva que se
 * olvide del filtro tiene que poner esto en rojo sola. Es la lección de la
 * quinta extensión de `secrets.md` aplicada al derecho: no alcanza con auditar
 * los archivos que uno se acuerda de nombrar.
 *
 * ## Correr
 *
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-public-metadata-exposure.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  PUBLIC_PRODUCT_METADATA_KEYS,
  PUBLIC_VARIANT_METADATA_KEYS,
} from "../../lib/product-metadata/public-keys";

const STORE_PRODUCTS_DIR = join(
  process.cwd(),
  "src",
  "api",
  "store",
  "products"
);

/**
 * Claves que NUNCA pueden estar en el allowlist. No es la lista de todo lo
 * sensible —el allowlist protege por construcción contra lo que no enumera—
 * sino un segundo cinturón sobre lo que ya sabemos que duele: si alguien agrega
 * `vendor_full_name` "porque el storefront lo necesita", esto lo frena.
 */
const FORBIDDEN_SUBSTRINGS = [
  "vendor",
  "qb_",
  "quickbooks",
  "cost",
  "margin",
  "sourced_via_agent",
  "internal",
  "never_sync",
  "sales_description",
];

/**
 * Rutas que piden `variants.*` pero NO devuelven variantes, con el motivo
 * verificado. Se declaran por nombre: una exención sin motivo escrito es una
 * excepción heredada que nadie vuelve a mirar.
 */
const VARIANT_FETCH_EXEMPT: Map<string, string> = new Map([
  [
    "src/api/store/products/batch-prices/route.ts",
    "pide variants.* sólo para resolver price_set ids; su respuesta es " +
      "{prices, customer_type, store_config} — ninguna variante sale (verificado 2026-09-05)",
  ],
]);

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listRouteFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/** Descarta las líneas de `import`: importar el filtro no es aplicarlo. */
function withoutImports(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line))
    .join("\n");
}

/**
 * Extrae el argumento `{...}` de cada `query.graph(` del archivo, cortando por
 * llave balanceada.
 *
 * Nada de ventanas de N caracteres: ese modo de falla ya mordió dos veces en
 * este repo (2026-07-29 y 2026-08-17), las dos porque alguien agregó un
 * comentario y el verificador empezó a mentir.
 */
function extractQueryGraphCalls(source: string): string[] {
  const calls: string[] = [];
  const needle = "query.graph(";
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    let i = source.indexOf("{", at);
    if (i === -1) break;
    let depth = 0;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          calls.push(source.slice(source.indexOf("{", at), i + 1));
          break;
        }
      }
    }
    from = i + 1;
  }
  return calls;
}

/**
 * ¿Este `query.graph` trae el `metadata` de un PRODUCTO?
 *
 * La pregunta importa porque varias rutas de catálogo leen `store.metadata`
 * para sacar `non_wholesale_prefixes` — dato de configuración, no del producto —
 * y tratarlas como fuga sería ruido. Un verificador ruidoso se termina
 * ignorando, que es exactamente como deja de valer.
 */
function fetchesProductMetadata(call: string): boolean {
  if (!/entity\s*:\s*["']product["']/.test(call)) return false;
  const fields = call.match(/fields\s*:\s*\[([\s\S]*?)\]/);
  return fields !== null && /["']metadata["']/.test(fields[1] ?? "");
}

function main(): void {
  console.log("── verify-public-metadata-exposure ─────────────────────────\n");

  // ── §A: el allowlist no contiene nada sensible ────────────────────────────
  console.log("§A allowlist");
  check(
    "   el allowlist no está vacío",
    PUBLIC_PRODUCT_METADATA_KEYS.length > 0,
    `${PUBLIC_PRODUCT_METADATA_KEYS.length} claves`
  );
  for (const key of PUBLIC_PRODUCT_METADATA_KEYS) {
    const hit = FORBIDDEN_SUBSTRINGS.find((f) => key.toLowerCase().includes(f));
    check(`   "${key}" no es una clave interna`, !hit, hit ? `contiene "${hit}"` : "");
  }

  // ── §B: toda ruta que PIDE metadata también la FILTRA ─────────────────────
  console.log("\n§B rutas de /store/products");
  const routes = listRouteFiles(STORE_PRODUCTS_DIR);
  check(
    "   se encontraron rutas para auditar",
    routes.length > 0,
    `${routes.length} route.ts`
  );

  let asked = 0;
  for (const file of routes) {
    const rel = file.slice(process.cwd().length + 1);
    const source = readFileSync(file, "utf8");
    const body = withoutImports(source);

    // ¿Algún `query.graph` de este archivo trae metadata de PRODUCTO?
    // (leer `store.metadata` para sacar `non_wholesale_prefixes` no cuenta)
    const asksMetadata = extractQueryGraphCalls(body).some(fetchesProductMetadata);
    if (!asksMetadata) {
      console.log(`   ➖ ${rel} — no pide product.metadata, nada que filtrar`);
      continue;
    }
    asked++;

    // Aplicar = MENCIONAR uno de los dos helpers en el cuerpo (ya sin imports).
    // Se acepta tanto la llamada `fn(x)` como la referencia `.map(fn)`, que es
    // como lo usa el listado — exigir el paréntesis daba un falso NEGATIVO
    // justo sobre la ruta más expuesta de las cuatro.
    const applies =
      /\bwithPublicProductMetadata\b/.test(body) ||
      /\bpickPublicProductMetadata\b/.test(body);
    check(`   ${rel} pide product.metadata y la filtra`, applies);
  }

  check(
    "   al menos una ruta pide metadata (si no, este check pasa en vacío)",
    asked > 0,
    `${asked} rutas piden metadata`
  );

  // ── §C: colecciones SECUNDARIAS de productos, afirmadas por NOMBRE ────────
  //
  // §B mira el archivo entero, así que sólo caza "esta ruta se olvidó del
  // filtro". No caza "esta ruta filtra una colección y no la otra": `by-handle`
  // devuelve `product` Y `related_products`, y con el filtro puesto sólo en el
  // primero §B seguía en verde. Lo destapó el mutation test, no la lectura.
  //
  // Estas claves se afirman por nombre —la misma disciplina que `MUST_GATE_ROUTES`
  // usa para los gates de PIN— porque un check que depende de que el archivo
  // mencione algo no puede ver lo que el archivo omite.
  console.log("\n§C colecciones secundarias de productos");
  const SECONDARY_PRODUCT_KEYS = ["related_products"];
  let secondaryFound = 0;
  for (const file of routes) {
    const rel = file.slice(process.cwd().length + 1);
    const body = withoutImports(readFileSync(file, "utf8"));
    for (const key of SECONDARY_PRODUCT_KEYS) {
      const re = new RegExp(`^.*\\b${key}\\s*:.*$`, "gm");
      for (const line of body.match(re) ?? []) {
        // Sólo interesa la línea que ARMA la respuesta, no una lectura interna
        // (`product.metadata?.related_products` es un read, no un return).
        if (/\.metadata\??\./.test(line)) continue;
        secondaryFound++;
        check(
          `   ${rel} filtra "${key}" en la respuesta`,
          /PublicProductMetadata/.test(line),
          line.trim().slice(0, 80)
        );
      }
    }
  }
  check(
    "   se encontró al menos una colección secundaria (si no, §C pasa en vacío)",
    secondaryFound > 0,
    `${secondaryFound} ocurrencia(s)`
  );

  // ── §D: metadata de VARIANTE ──────────────────────────────────────────────
  //
  // El nivel que faltaba, y era el peor. `/store/products*` pide `variants.*`,
  // que expande metadata; medido contra el sandbox el 2026-09-05, la respuesta
  // pública traía 14 claves sensibles POR VARIANTE — `average_cost` (2.517
  // variantes en prod) y `purchase_cost` (2.537), o sea el COGS por SKU.
  //
  // Con §A/§B sólo, el verificador daba VERDE con esa fuga abierta: el filtro
  // estaba puesto en el nivel que se había mirado. Por eso §D pregunta por el
  // otro.
  console.log("\n§D metadata de variante");
  for (const key of PUBLIC_VARIANT_METADATA_KEYS) {
    const hit = FORBIDDEN_SUBSTRINGS.find((f) => key.toLowerCase().includes(f));
    check(`   "${key}" no es una clave interna`, !hit, hit ? `contiene "${hit}"` : "");
  }
  console.log(
    `   (allowlist de variante: ${PUBLIC_VARIANT_METADATA_KEYS.length} claves)`
  );

  let variantRoutes = 0;
  for (const file of routes) {
    const rel = file.slice(process.cwd().length + 1);
    const body = withoutImports(readFileSync(file, "utf8"));

    // ¿Pide `variants.*`? Eso expande la metadata de variante.
    const asksVariants = extractQueryGraphCalls(body).some(
      (call) =>
        /entity\s*:\s*["']product["']/.test(call) &&
        /["']variants\.\*["']/.test(call)
    );
    if (!asksVariants) continue;

    // Exenciones DECLARADAS, con motivo verificado. Una ruta puede pedir
    // `variants.*` para resolver algo y no devolver ninguna variante; tratarla
    // como fuga sería ruido, y un verificador ruidoso se termina ignorando.
    const exemptReason = VARIANT_FETCH_EXEMPT.get(rel);
    if (exemptReason) {
      console.log(`   ➖ ${rel} — exenta: ${exemptReason}`);
      continue;
    }
    variantRoutes++;

    // Cubierta si filtra variantes explícitamente, o si pasa el producto entero
    // por el helper (que desde el 2026-09-05 también filtra sus variantes).
    const filters =
      /\bwithPublicVariantMetadata\b/.test(body) ||
      /\bpickPublicVariantMetadata\b/.test(body) ||
      /\bwithPublicProductMetadata\b/.test(body);
    check(`   ${rel} pide variants.* y las filtra`, filters);

    // Y la trampa concreta: una clave `variants:` que PISE el spread después
    // del helper tiene que llevar su propio filtro.
    for (const line of body.match(/^\s*variants\s*:.*$/gm) ?? []) {
      if (/^\s*variants\s*:\s*\[/.test(line)) continue; // literal vacío
      check(
        `   ${rel} · la clave \`variants:\` que pisa el spread va filtrada`,
        /PublicVariantMetadata/.test(line),
        line.trim().slice(0, 74)
      );
    }
  }
  check(
    "   al menos una ruta pide variants.* (si no, §D pasa en vacío)",
    variantRoutes > 0,
    `${variantRoutes} rutas`
  );

  console.log("");
  if (failures > 0) {
    console.log(`❌ ${failures} chequeo(s) fallaron.`);
    process.exit(1);
  }
  console.log("✅ Todos los chequeos pasaron.");
}

main();
