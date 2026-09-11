/**
 * verify-cart-bom-sync.ts — BOM de proyecto → carrito de la web.
 *
 *   (a) la ruta exige cliente autenticado en el MIDDLEWARE (matcher por nombre),
 *       y lee el customer_id del auth_context, nunca del body
 *   (b) las claves del vínculo en cart.metadata son las MISMAS que escriben
 *       set-bl-link / set-ll-link (se leen de esos archivos, no se re-tipean)
 *   (c) las claves de provenance por línea son las MISMAS que sync-pos
 *   (d) semántica de reemplazo: delete de las líneas del proyecto ANTES del add
 *   (e) cada línea se agrega en su propio workflow (una sin stock no tumba el resto)
 *   (f) SKU → variante sólo PUBLICADA y del sales channel del carrito
 *   (g) el sync-bom/route.ts está fuera del ISR de la web (no aplica acá) — y
 *       completeCartWorkflow copia cart.metadata a la orden (se lee del paquete)
 *
 * READ-ONLY. exit 1 ante cualquier FAIL.
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-cart-bom-sync.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
interface Check {
  label: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
const record = (label: string, pass: boolean, detail: string) =>
  checks.push({ label, pass, detail });
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "");
}

// (a) middleware + auth_context
{
  const mw = code(read("src/api/middlewares.ts")).replace(/\s+/g, " ");
  // El bloque del matcher: desde su `matcher:` hasta el cierre `] }` del objeto.
  const m = mw.match(/matcher: "\/store\/carts\/:id\/sync-bom", method: "POST", middlewares: \[(.*?)\],?\s*\}/);
  record("middlewares: matcher /store/carts/:id/sync-bom POST", !!m, "src/api/middlewares.ts");
  record("middlewares: authenticate(\"customer\", [\"session\", \"bearer\"])", !!m && /authenticate\("customer", \["session", "bearer"\]\)/.test(m[1]), m?.[1] ?? "(sin matcher)");
  const route = code(read("src/api/store/carts/[id]/sync-bom/route.ts"));
  record("route: customer_id desde auth_context.actor_id", /auth_context\?\.actor_id/.test(route), "route.ts");
  record("route: 401 sin actor", /status\(401\)/.test(route), "route.ts");
  record("route: el body NO puede fijar customer_id", !/customer_id/.test(route.replace(/customerId/g, "")), "route.ts");
}

// (b) claves del vínculo = set-bl-link / set-ll-link
{
  const types = read("src/lib/bom/types.ts");
  const bl = read("src/api/admin/draft-orders/[id]/set-bl-link/route.ts");
  const ll = read("src/api/admin/draft-orders/[id]/set-ll-link/route.ts");
  for (const key of ["backlighting_project_id", "backlighting_seq_id", "backlighting_linked_at", "backlighting_linked_by"]) {
    record(`vínculo BL: ${key} existe en set-bl-link y en bom/types`, bl.includes(key) && types.includes(`"${key}"`), key);
  }
  for (const key of ["ll_project_id", "ll_seq_id", "ll_linked_at", "ll_linked_by"]) {
    record(`vínculo LL: ${key} existe en set-ll-link y en bom/types`, ll.includes(key) && types.includes(`"${key}"`), key);
  }
}

// (c) provenance = sync-pos
{
  const types = read("src/lib/bom/types.ts");
  const syncPos = read("src/api/admin/draft-orders/sync-pos/route.ts");
  for (const key of ["source_app", "source_project_id", "source_key"]) {
    record(`provenance: ${key} en sync-pos y en bom/types`, syncPos.includes(`${key}:`) && types.includes(`"${key}"`), key);
  }
}

// (d)(e)(f) semántica
{
  const sync = code(read("src/lib/bom/sync-cart-bom.ts"));
  const del = sync.indexOf("deleteLineItemsWorkflow(container)");
  const add = sync.indexOf("addToCartWorkflow(container)");
  record("sync: borra las líneas del proyecto ANTES de agregar", del > -1 && add > -1 && del < add, `delete@${del} add@${add}`);
  record("sync: filtra las líneas a borrar por source_app + source_project_id", /source_app.*=\s*\$2/.test(sync.replace(/\s+/g, " ")) && /source_project_id.*=\s*\$3/.test(sync.replace(/\s+/g, " ")), "cart_line_item WHERE");
  record("sync: un add por línea dentro de try/catch (unavailable)", /for \(const line of lines\) \{[\s\S]*try \{[\s\S]*addToCartWorkflow[\s\S]*\} catch/.test(sync), "sync-cart-bom.ts");
  record("sync: cart de otro cliente → CART_CUSTOMER_MISMATCH", /CART_CUSTOMER_MISMATCH/.test(sync), "sync-cart-bom.ts");
  record("sync: metadata read-modify-write (…cart.metadata)", /\.\.\.\(cart\.metadata \?\? \{\}\)/.test(sync), "sync-cart-bom.ts");
  const resolve = code(read("src/lib/bom/resolve-bom-skus.ts")).replace(/\s+/g, " ");
  record("resolve: sólo productos published", /p\.status = 'published'/.test(resolve), "resolve-bom-skus.ts");
  record("resolve: filtra por sales channel del carrito", /product_sales_channel psc/.test(resolve), "resolve-bom-skus.ts");
}

// (g) completeCart copia cart.metadata a la orden (lo que hace que el vínculo viaje)
{
  const rel = "node_modules/@medusajs/core-flows/dist/cart/workflows/complete-cart.js";
  let ok = false;
  try {
    ok = /metadata: cart\.metadata/.test(read(rel));
  } catch {
    /* paquete ausente */
  }
  record("core-flows: completeCartWorkflow copia cart.metadata a la orden", ok, rel);
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label} — ${c.detail}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
