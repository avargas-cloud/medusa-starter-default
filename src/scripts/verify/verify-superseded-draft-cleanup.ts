/**
 * verify-superseded-draft-cleanup.ts
 *
 * Gate estático de la limpieza del draft PERDEDOR de un doble submit.
 *
 * QUÉ PROTEGE
 *   `convert-force` detecta el duplicado, devuelve la orden ganadora con
 *   `deduplicated: true` y —hasta el 2026-08-20— dejaba el draft perdedor vivo.
 *   Ese huérfano aparece en /estimates como trabajo pendiente y dispara una
 *   alerta falsa de "Missing in QB": es E3132.
 *
 * POR QUÉ ES ESTÁTICO Y NO ALCANZA SOLO
 *   Lo que este archivo puede afirmar son INVARIANTES DE FORMA: que la llamada
 *   existe, que está guardada, y que el orden de las sentencias hace la falla
 *   ABIERTA. Que la cancelación realmente ocurra contra Postgres lo prueba
 *   `src/scripts/tests/e2e-superseded-draft-cleanup-sandbox.ts`, no esto.
 *
 * DOS TRAMPAS QUE ESTE REPO YA PAGÓ, EVITADAS ACÁ
 *   · Un check que busca "llama a X" sobre el ARCHIVO ENTERO acepta el `import`.
 *     Acá se descartan las líneas de import antes de buscar la llamada.
 *   · Un check que recorta una VENTANA DE TAMAÑO FIJO miente el día que alguien
 *     escribe un comentario largo. Acá se recorta por marcadores estructurales.
 *
 * CORRER:
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-superseded-draft-cleanup.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const ROOT = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

const CONVERT = "src/api/admin/draft-orders/[id]/convert-force/route.ts";
const VOID = "src/api/admin/draft-orders/[id]/void/route.ts";
const HELPER = "src/lib/draft-orders/cancel-draft-order.ts";

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const ok = (name: string, cond: boolean, detail?: string) =>
  checks.push({ name, ok: cond, detail });

/** El cuerpo del archivo sin sus líneas de import — para que un import no cuente como uso. */
function withoutImports(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*\}\s*from\s+["']/.test(l))
    .join("\n");
}

/**
 * El código sin comentarios.
 *
 * Hace falta porque un check sobre el texto plano confunde PROSA con CÓDIGO: el
 * primer intento de 3e daba rojo porque el helper NOMBRA a QuickBooks en el
 * comentario que explica por qué QuickBooks no está ahí. Un verificador que se
 * dispara con su propia documentación se termina ignorando.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

// ─── 1 · convert-force: la rama dedup CANCELA al perdedor ────────────────────
{
  const src = read(CONVERT);
  const body = withoutImports(src);

  ok(
    "1a · convert-force llama a cancelDraftOrder (no sólo lo importa)",
    /cancelDraftOrder\s*\(/.test(body),
    "sin esta llamada el perdedor queda huérfano — es el bug de E3132"
  );

  // La rama se recorta del CÓDIGO SIN COMENTARIOS, y por marcadores
  // estructurales, nunca por un largo fijo.
  //
  // Lo de "sin comentarios" no es prolijidad: el mutation test destapó que 1d
  // era VACUO. El comentario que explica el guard de identidad contiene el texto
  // `dup.id !== id`, así que el check pasaba con el guard BORRADO — justo el
  // check que impide anular la venta ganadora. Un verificador que se satisface
  // con su propia documentación no verifica nada.
  const codeSrc = codeOnly(src);
  const start = codeSrc.indexOf("if (dup)");
  const end = codeSrc.indexOf("deduplicated: true", start);
  ok(
    "1b · la rama `deduplicated` se puede delimitar",
    start !== -1 && end > start,
    `start=${start} end=${end}`
  );
  const branch = start !== -1 && end > start ? codeSrc.slice(start, end) : "";

  ok(
    "1c · la cancelación vive DENTRO de la rama `deduplicated`",
    /cancelDraftOrder\s*\(/.test(branch),
    "fuera de la rama cancelaría drafts que no perdieron nada"
  );

  ok(
    "1d · guard de identidad: no cancela si el ganador ES este draft",
    /dup\.id\s*!==\s*id/.test(branch),
    "sin esto, un ganador mal resuelto anula la venta que acaba de ocurrir"
  );

  ok(
    "1e · estampa la relación con el ganador",
    /supersededMetadata\s*\(/.test(branch),
    "el estado canónico es `canceled`; la relación va en metadata"
  );

  // ── Falla ABIERTA: el orden de las sentencias es la garantía ──────────────
  const tryIdx = branch.indexOf("try {");
  const callIdx = branch.indexOf("cancelDraftOrder(");
  const catchIdx = branch.indexOf("catch", callIdx === -1 ? 0 : callIdx);
  const respIdx = branch.indexOf("res.status(200)");
  ok(
    "1f · la limpieza está envuelta en try/catch",
    tryIdx !== -1 && callIdx > tryIdx && catchIdx > callIdx,
    `try=${tryIdx} call=${callIdx} catch=${catchIdx}`
  );
  ok(
    "1g · FALLA ABIERTA: la orden ganadora se responde DESPUÉS del catch",
    respIdx > catchIdx && catchIdx !== -1,
    "si la respuesta quedara dentro del try, un fallo de limpieza trabaría la caja " +
      "con la venta ya hecha y el cliente enfrente"
  );

  ok(
    "1h · el import del helper es ESTÁTICO, no `await import()`",
    /^import\s*\{[^}]*cancelDraftOrder/m.test(src) &&
      !/await\s+import\s*\(\s*["'][^"']*cancel-draft-order/.test(src),
    "un import dinámico relativo sin extensión compila y muere en runtime con " +
      "ERR_MODULE_NOT_FOUND — ya pasó dos veces en este repo"
  );
}

// ─── 2 · El void del operador usa el MISMO chokepoint ────────────────────────
{
  const src = read(VOID);
  const body = withoutImports(src);
  ok(
    "2a · el route /void delega en cancelDraftOrder",
    /cancelDraftOrder\s*\(/.test(body),
    "dos caminos que cancelan un draft no pueden divergir"
  );
  ok(
    "2b · /void ya no corre cancelOrderWorkflow por su cuenta",
    !/cancelOrderWorkflow\s*\(/.test(body),
    "una segunda copia del cancel es exactamente cómo los dos caminos divergen"
  );
  ok(
    "2c · /void conserva su 409 accionable de fulfillments",
    /has_active_fulfillments/.test(src),
    "el POS muestra esa guía al operador"
  );
}

// ─── 3 · El helper no puede tirar ni saltarse sus precondiciones ─────────────
{
  const src = read(HELPER);
  ok(
    "3a · el helper re-lee la orden en vez de confiar en el caller",
    /retrieveOrder\s*\(/.test(src),
    "entre la detección del duplicado y la limpieza, otra sesión pudo convertir " +
      "o cancelar este mismo draft"
  );
  ok(
    "3b · es idempotente: una orden ya cancelada es no-op, no error",
    /already_canceled/.test(src)
  );
  ok(
    "3c · sólo cancela drafts",
    /is_draft_order/.test(src) && /not_a_draft/.test(src)
  );
  const cancelIdx = src.indexOf("cancelOrderWorkflow(");
  const tryBefore = src.lastIndexOf("try {", cancelIdx);
  const catchAfter = src.indexOf("catch", cancelIdx);
  ok(
    "3d · el cancel está dentro de try/catch — el helper NUNCA tira",
    cancelIdx !== -1 && tryBefore !== -1 && catchAfter > cancelIdx,
    "su caller está en el camino de una venta que ya ocurrió"
  );
  ok(
    "3e · el helper NO toca QuickBooks (mira CÓDIGO, no comentarios)",
    !/quickbooks|processDeactivateEstimateInQb/i.test(codeOnly(src)),
    "el perdedor de un doble submit no tiene estimate en QB; " +
      "meter QB acá le agrega una dependencia que no puede hacer nada útil"
  );
}

// ─── Reporte ─────────────────────────────────────────────────────────────────
const bad = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`  ${c.ok ? "ok " : "NO "} ${c.name}${c.ok || !c.detail ? "" : `\n        → ${c.detail}`}`);
}
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed`);
process.exit(bad.length ? 1 : 0);
