/**
 * Verifica que un credit memo en $0 (o negativo) NO pueda existir.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * 2026-09-17, CM-1173/CM-1174 (orden 2577): una devolución parcial heredó el
 * descuento de orden de la factura como monto FIJO entero (−$198.61 sobre
 * $154.98 de ítems). El POS clampeó el total a $0.00 y lo guardó; `complete`
 * emitió el store credit por el SUBTOTAL (`total || subtotal`), el GL registró
 * `Sales Discounts −198.61`, y QuickBooks rechazó el documento con 3180. Tres
 * capas con tres números para un mismo documento, ninguna avisó.
 *
 * ── Qué chequea ───────────────────────────────────────────────────────────────
 *   1. el helper `creditMemoTotalViolation` rechaza discount > subtotal y
 *      total ≤ 0, y acepta un memo sano (unit, en proceso)
 *   2. las TRES rutas que fijan totales de un credit memo (`sync`, `complete`,
 *      `edit`) LLAMAN al helper — se cuenta la llamada, no el import: un
 *      `import` suelto acredita cero (lección de verify-pin-enforcement §4b)
 *   3. `complete` no vuelve a "rellenar" el crédito con el subtotal
 *      (`total || subtotal`): el crédito emitido es el total del memo
 *   4. `edit` re-postea el GL (reverse + post) — un edit sin eso deja el libro
 *      diciendo lo que el documento ya no dice
 *
 * Mutation-test (obligatorio antes de creerle): quitar la llamada al helper de
 * una ruta → §2 rojo; restaurar `total || subtotal` → §3 rojo; quitar
 * `reverseCreditMemo` del edit → §4 rojo.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-credit-memo-positive-total.ts
 */

import fs from "node:fs";
import path from "node:path";

import { creditMemoTotalViolation } from "../../lib/pos/credit-memo-total-guard";

const ROUTES_DIR = path.join(process.cwd(), "src/api/admin/pos/credit_memos");
const failures: string[] = [];
const ok: string[] = [];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:"'`])\/\/.*$/gm, "$1");
}

/** Líneas de código sin imports: un `import { x }` no es una llamada a `x`. */
function codeWithoutImports(file: string): string {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  return src
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*}\s*from\s+["']/.test(l))
    .join("\n");
}

// ── 1 · el helper muerde ──────────────────────────────────────────────────────
const base = {
  subtotal: 15498,
  discount: 1551,
  shipping: 0,
  tax: 976,
  total: 14923,
};
const cases: Array<
  [string, Parameters<typeof creditMemoTotalViolation>[0], boolean]
> = [
  ["memo sano", base, false],
  [
    "discount > subtotal (CM-1173 real)",
    { ...base, discount: 19861, total: 0 },
    true,
  ],
  ["total 0 sin descuento", { ...base, discount: 0, total: 0 }, true],
  ["total negativo", { ...base, total: -1 }, true],
  [
    "sólo flete (subtotal 0, total > 0)",
    { subtotal: 0, discount: 0, shipping: 4500, tax: 0, total: 4500 },
    false,
  ],
];
for (const [name, totals, shouldReject] of cases) {
  const v = creditMemoTotalViolation(totals);
  if (Boolean(v) !== shouldReject) {
    failures.push(
      `§1 helper: "${name}" esperaba ${shouldReject ? "RECHAZO" : "OK"}, dio ${v ?? "OK"}`
    );
  } else {
    ok.push(`§1 helper: ${name}`);
  }
}
const msg =
  creditMemoTotalViolation({ ...base, discount: 19861, total: 0 }) ?? "";
if (!/198\.61/.test(msg) || !/154\.98/.test(msg)) {
  failures.push(`§1 el mensaje no nombra los dos montos en dólares: "${msg}"`);
}

// ── 2 · las tres rutas LLAMAN al helper ───────────────────────────────────────
const ROUTES = {
  sync: path.join(ROUTES_DIR, "sync/route.ts"),
  complete: path.join(ROUTES_DIR, "[id]/complete/route.ts"),
  edit: path.join(ROUTES_DIR, "[id]/edit/route.ts"),
};
const CALL_RE = /creditMemoTotalViolation\s*\(/;
for (const [name, file] of Object.entries(ROUTES)) {
  if (!fs.existsSync(file)) {
    failures.push(
      `§2 ${name}: no existe ${path.relative(process.cwd(), file)}`
    );
    continue;
  }
  const code = codeWithoutImports(file);
  if (!CALL_RE.test(code)) {
    failures.push(
      `§2 ${name}: no LLAMA a creditMemoTotalViolation() (el import no cuenta)`
    );
  } else if (!/status\(400\)/.test(code)) {
    failures.push(`§2 ${name}: llama al helper pero no contesta 400`);
  } else {
    ok.push(`§2 ${name} llama al guard y contesta 400`);
  }
}

// ── 3 · complete emite el crédito por el TOTAL ────────────────────────────────
{
  const code = codeWithoutImports(ROUTES.complete);
  if (
    /\.total\s*\|\|\s*\(?\s*creditMemo\s+as\s+any\)?\.subtotal|\.total\s*\|\|/.test(
      code
    )
  ) {
    failures.push(
      "§3 complete: volvió el fallback `total || subtotal` — el crédito saldría por otro número"
    );
  } else if (
    !/const cmTotal = Number\(\(creditMemo as any\)\.total\)/.test(code)
  ) {
    failures.push(
      "§3 complete: no se encontró `const cmTotal = Number((creditMemo as any).total)`"
    );
  } else {
    ok.push("§3 complete: cmTotal = total del memo, sin fallback");
  }
}

// ── 4 · edit re-postea el GL ──────────────────────────────────────────────────
{
  const code = codeWithoutImports(ROUTES.edit);
  const reverses = /reverseCreditMemo\s*\(/.test(code);
  const posts = /postCreditMemo\s*\(/.test(code);
  const hooked = /runLedgerHook\s*\(/.test(code);
  if (!reverses || !posts || !hooked) {
    failures.push(
      `§4 edit: GL no se re-postea (reverse=${reverses} post=${posts} hook=${hooked})`
    );
  } else {
    ok.push(
      "§4 edit: reverseCreditMemo + postCreditMemo dentro de runLedgerHook"
    );
  }
}

// ── Reporte ───────────────────────────────────────────────────────────────────
for (const line of ok) console.log(`✅ ${line}`);
for (const line of failures) console.log(`❌ ${line}`);
console.log(
  `\n${failures.length === 0 ? "PASS" : "FAIL"} — ${ok.length} ok · ${failures.length} fallos`
);
if (failures.length > 0) process.exit(1);
