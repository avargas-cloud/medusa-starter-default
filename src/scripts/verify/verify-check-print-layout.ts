/**
 * verify-check-print-layout — gate estático de check-print-stock-20260918:
 * GET es Accounting, PUT es Owner, el PUT valida con zod antes de tocar la
 * base, el UPDATE nunca pisa el resto de `store.metadata`, y el layout es
 * config de impresión — no se mete en los documentos del GL. Sin DB. Corre:
 *
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-check-print-layout.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string): string => readFileSync(resolve(root, p), "utf8");
/** Líneas de código sin imports ni comentarios de línea: un check de "llama a X" nunca acepta el import. */
const code = (src: string): string =>
  src.split("\n").filter((l) => !/^\s*(import|\/\/|\*|\/\*)/.test(l)).join("\n");

let failures = 0;
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

const walk = (dir: string): string[] => {
  const abs = resolve(root, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = join(abs, entry);
    const rel = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
};

// ── 1 · la ruta existe, GET es Accounting y PUT es Owner ────────────────────
const routePath = "src/api/admin/settings/check-print-layout/route.ts";
const route = read(routePath);
const routeCode = code(route);
const putIdx = routeCode.indexOf("export async function PUT");
check(putIdx >= 0, "ruta: exporta PUT");
const getBlock = routeCode.slice(0, putIdx >= 0 ? putIdx : routeCode.length);
const putBlock = putIdx >= 0 ? routeCode.slice(putIdx) : "";
check(/assertAccounting\(/.test(getBlock), "ruta: GET llama assertAccounting(");
check(/assertOwner\(/.test(putBlock), "ruta: PUT (después de su export) llama assertOwner(");
check(!/assertOwner\(/.test(getBlock), "ruta: GET no llama assertOwner( (sería más restrictivo de lo pedido)");

// ── 2 · el PUT valida con zod y contesta 400 al fallar ──────────────────────
check(/checkPrintLayoutSchema\.safeParse\(/.test(putBlock), "ruta: PUT valida con checkPrintLayoutSchema.safeParse(");
check(/status\(400\)/.test(putBlock) && /!parsed\.success/.test(putBlock), "ruta: PUT contesta 400 cuando el parse falla");

// ── 3 · el UPDATE nunca pisa el resto de metadata ───────────────────────────
check(
  /COALESCE\(metadata,\s*'\{\}'::jsonb\)\s*\|\|\s*jsonb_build_object\('check_print_layout'/.test(route),
  "ruta: el UPDATE concatena con || jsonb_build_object('check_print_layout' (nunca SET metadata = $1)"
);
check(!/SET metadata = \$1/.test(routeCode), "ruta: no hay un SET metadata = $1 que pise el resto del jsonb");

// ── 4 · el lib exporta lo esperado y el schema es estricto ──────────────────
const libPath = "src/lib/pos/check-print-layout.ts";
const lib = read(libPath);
check(/export const DEFAULT_CHECK_PRINT_LAYOUT/.test(lib), "lib: exporta DEFAULT_CHECK_PRINT_LAYOUT");
check(/export function parseStoredCheckPrintLayout\(/.test(lib), "lib: exporta parseStoredCheckPrintLayout(");
check(/checkPrintLayoutSchema = z\n\s*\.object/.test(lib), "lib: checkPrintLayoutSchema arranca de z.object(...)");
// El bloque contiene DOS `.strict()`: el de `fields` (sub-objeto) y el de la
// raíz (último, cerrando la constante). Contar "al menos uno" no alcanza —
// hace falta que el `})` que cierra el objeto RAÍZ esté seguido por
// `.strict();`, si no un mutante que borra sólo el strict de la raíz (dejando
// el de `fields` intacto) pasa en vacío.
check(
  /export const checkPrintLayoutSchema = z[\s\S]*\n {2}\}\)\n {2}\.strict\(\);/.test(lib),
  "lib: checkPrintLayoutSchema es .strict() EN LA RAÍZ (no sólo en fields)"
);

// ── 5 · el layout no se mete en los documentos del GL ───────────────────────
const ledgerDocsFiles = walk("src/lib/ledger/documents");
const tainted = ledgerDocsFiles.filter((f) => code(read(f)).includes("check_print_layout"));
check(tainted.length === 0, "src/lib/ledger/documents/**: ningún documento del GL menciona check_print_layout (es config de impresión, no del documento)");
if (tainted.length > 0) console.log(`   archivos con la mención: ${tainted.join(", ")}`);

console.log(failures === 0 ? "\n✅ verify-check-print-layout: todo verde" : `\n❌ verify-check-print-layout: ${failures} check(s) rojos`);
process.exit(failures === 0 ? 0 : 1);

/*
 * Mutation tests (2026-09-18), corridos de verdad contra copias restauradas
 * desde el scratchpad de la sesión — cada rama se rompió a propósito, se
 * confirmó el ✗, y se restauró desde el backup antes de seguir:
 *   1 · cambié GET a `assertOwner(` → cayeron "GET llama assertAccounting("
 *       Y "GET no llama assertOwner(" (el negativo es el que detecta un GET
 *       más restrictivo de lo pedido, no sólo la ausencia del positivo).
 *   2 · el `if (!parsed.success)` del PUT se cambió a `if (false)` → cayó
 *       "PUT contesta 400 cuando el parse falla".
 *   3 · cambié el UPDATE a `SET metadata = $1` (perdiendo el resto del jsonb)
 *       → cayeron tanto el check positivo del `||` como el negativo de `$1`.
 *   4 · saqué el `.strict()` de la RAÍZ del schema (dejando el de `fields`
 *       intacto) → la primera versión del check 4 (buscaba `.strict()` en
 *       cualquier parte del bloque) NO lo cazó — pasó en vacío porque el
 *       `.strict()` de `fields` seguía ahí. El unit spec ("rejects an
 *       unknown key at the root") sí lo cazó, lo que destapó el check
 *       flojo. Se reescribió para exigir que el `})` que cierra la raíz esté
 *       seguido por `.strict();` — con eso la misma mutación sí cae.
 *   5 · agregué `export const __mut_test = "check_print_layout";` a
 *       `src/lib/ledger/documents/bank-check.ts` → cayó el check 5 y listó
 *       el archivo.
 */
