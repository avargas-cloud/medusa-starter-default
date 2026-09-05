/**
 * verify-pos-prefix-auth.ts
 *
 * Afirma que TODA ruta bajo `src/api/pos/**` está cubierta por un middleware que
 * autentica de verdad.
 *
 * ## Qué falla esto
 *
 * Hasta el 2026-09-05, `/pos/*` sólo tenía `posCorsMiddleware`. El comentario
 * decía "no Medusa auth gating — validated in-route" y esa validación in-route
 * NO EXISTÍA: `GET /pos/document-templates` contestaba 200 con 390 KB en
 * producción, sin un solo header, mientras `/admin/document-templates` daba 401.
 * El malentendido estaba escrito en el propio handler: "POS users authenticate
 * with pos_user tokens which satisfy storeCors auth". CORS no autentica — es una
 * instrucción para navegadores, y `curl` la ignora.
 *
 * ## Por qué chequea la FORMA del matcher y no sólo que diga `authenticate`
 *
 * Por la regla de `defineMiddlewares` medida el 2026-08-20: una entrada CON
 * `method` se registra como `app[method](matcher, …)` = match EXACTO de path;
 * sólo una SIN `method` cae en `app.use(matcher)` = match por PREFIJO. O sea que
 * agregarle un `method: "GET"` a la entrada de `/pos/*` la dejaría cubriendo
 * exactamente nada de las sub-rutas, con el `authenticate(` todavía escrito ahí
 * y este verificador en verde si sólo buscara el string. Por eso §2 existe.
 *
 * ## Correr
 *
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-pos-prefix-auth.ts
 *
 * NO usa `export default` a propósito: los verificadores que lo usan son scripts
 * de `medusa exec` y corridos con `tsx` no ejecutan nada y salen 0 — silencio
 * que se lee como aprobación.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(process.cwd(), "src", "api");
const POS_DIR = join(API_DIR, "pos");
const MIDDLEWARES = join(API_DIR, "middlewares.ts");

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  const mark = ok ? "✅" : "❌";
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
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

/**
 * Extrae el bloque `{ ... }` de la entrada de `defineMiddlewares` cuyo matcher
 * es `/pos/*`. Corta por el cierre balanceado de llaves, no por una ventana de
 * tamaño fijo: una ventana de N caracteres se rompe el día que alguien agrega un
 * comentario largo, y ese modo de falla ya mordió dos veces en este repo
 * (2026-07-29 y 2026-08-17).
 */
function extractPosMatcherEntry(source: string): string | null {
  const needle = 'matcher: "/pos/*"';
  const at = source.indexOf(needle);
  if (at === -1) return null;

  // Retroceder hasta la `{` que abre la entrada.
  let start = at;
  while (start > 0 && source[start] !== "{") start--;
  if (source[start] !== "{") return null;

  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function main(): void {
  console.log("── verify-pos-prefix-auth ──────────────────────────────────\n");

  const source = readFileSync(MIDDLEWARES, "utf8");
  const entry = extractPosMatcherEntry(source);

  // §1 — la entrada existe.
  check("§1 middlewares.ts declara un matcher \"/pos/*\"", entry !== null);
  if (!entry) {
    console.log("\nSin la entrada no hay nada más que afirmar.");
    process.exit(1);
  }

  // §2 — SIN `method`: si lo tuviera, matchearía exacto y no cubriría las hijas.
  check(
    "§2 la entrada NO declara `method` (o matchearía exacto, no por prefijo)",
    !/\bmethod\s*:/.test(entry),
    "regla de defineMiddlewares medida el 2026-08-20"
  );

  // §3 — llama `authenticate(...)` en su lista de middlewares. Se busca la
  // LLAMADA dentro del bloque, no la palabra en el archivo: un import no cuenta.
  // Ése es exactamente el defecto que §4b de verify-pin-enforcement tenía
  // documentado desde julio y sin aplicar.
  const callsAuthenticate = /middlewares\s*:\s*\[[^\]]*\bauthenticate\s*\(/s.test(entry);
  check("§3 la entrada llama `authenticate(...)`", callsAuthenticate);

  // §4 — el actor es `user`. El cajero del POS es un usuario ADMIN de Medusa
  // (login contra /auth/user/emailpass), así que autenticar `customer` dejaría
  // pasar a cualquier cliente del storefront.
  check(
    '§4 el actor autenticado es "user"',
    /authenticate\(\s*["']user["']/.test(entry),
    "un cajero es admin de Medusa, no customer"
  );

  // §5 — acepta bearer: es la única forma que manda el POS.
  check(
    "§5 acepta autenticación por bearer",
    /authenticate\([^)]*bearer/s.test(entry),
    "store-pos manda Authorization: Bearer, nunca cookie"
  );

  // §6 — el CORS corre ANTES del authenticate. Si no, un 401 saldría sin
  // cabeceras CORS y el navegador reportaría un error de CORS en vez del 401
  // real: el síntoma sería indescifrable.
  const corsAt = entry.indexOf("posCorsMiddleware");
  const authAt = entry.indexOf("authenticate(");
  check(
    "§6 posCorsMiddleware corre ANTES de authenticate",
    corsAt !== -1 && authAt !== -1 && corsAt < authAt
  );

  // §7 — ninguna ruta bajo src/api/pos/ queda fuera. El matcher es un prefijo,
  // así que hoy las cubre a todas; esto falla el día que alguien monte una ruta
  // POS fuera de ese árbol creyendo que hereda el gate.
  const posRoutes = listRouteFiles(POS_DIR);
  check(
    "§7 hay al menos una ruta bajo src/api/pos/ que el matcher cubre",
    posRoutes.length > 0,
    `${posRoutes.length} route.ts encontrados`
  );
  for (const r of posRoutes) {
    const rel = r.slice(API_DIR.length + 1);
    check(`   cubierta por /pos/*: ${rel}`, rel.startsWith("pos/"));
  }

  console.log("");
  if (failures > 0) {
    console.log(`❌ ${failures} chequeo(s) fallaron.`);
    process.exit(1);
  }
  console.log("✅ Todos los chequeos pasaron.");
}

main();
