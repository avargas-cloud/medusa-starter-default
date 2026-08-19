/**
 * Verifica que las fechas de NEGOCIO sigan ancladas a ET (America/New_York).
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El servidor (Railway) corre en UTC. `new Date().toISOString().split("T")[0]`
 * da la fecha UTC: a las 8pm de Miami ya es "mañana". Durante meses, 8 sitios
 * derivaron así el TxnDate que se manda a QuickBooks (credit memos de returns,
 * sales orders de void/post-edit-sync, TODOS los inventory adjustments), el
 * cierre de mes cortaba en medianoche UTC, y Treasury bucketizaba pagos por
 * `received_at::date` (UTC de sesión). Ninguna de esas fechas corridas rompe
 * un test ni se ve rara en pantalla — un documento contabilizado un día tarde
 * se ve EXACTAMENTE igual. Por eso este verificador existe.
 *
 * La auditoría y el fix: 2026-08-19. El helper canónico es
 * `getBusinessDateString` en `src/lib/date/et.ts` (unit-testeado, DST-safe).
 *
 * ── Qué chequea ───────────────────────────────────────────────────────────────
 *   1. el módulo ET existe y exporta los tres símbolos canónicos
 *   2. los 8 sitios que escriben TxnDate de QB llaman al helper (por NOMBRE de
 *      archivo — un sitio que no menciona nada no entra en un barrido por
 *      contenido; lección de verify-pin-enforcement §5) y no reincidieron en
 *      el patrón UTC
 *   3. los cortes de período (month-close + valuación) usan etMidnightUtc
 *   4. Treasury no deriva días con `::date` crudo sobre timestamptz
 *   5. store-pos resuelve rangos con lib/business-date (ET), sin copia local
 *
 * Los checks de "llama a X" descartan las líneas de import: un `import` solo
 * no prueba nada (defecto que §4a y §4b del verificador de PIN tuvieron que
 * corregir por separado — acá nace corregido).
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-et-business-dates.ts
 */
import fs from "node:fs";
import path from "node:path";

const BACKEND_ROOT = process.cwd();
const POS_ROOT = path.join(BACKEND_ROOT, "..", "store-pos");

const failures: string[] = [];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:"'`])\/\/.*$/gm, "$1");
}

/** Líneas de código sin imports/exports de re-export: donde un call cuenta. */
function codeLines(src: string): string {
  return stripComments(src)
    .split("\n")
    .filter((l) => !/^\s*(import|export)\s.*from\s/.test(l))
    .join("\n");
}

function readOrFail(file: string, base: string): string | null {
  const full = path.join(base, file);
  if (!fs.existsSync(full)) {
    failures.push(`${file}: NO EXISTE — si se movió, actualizar este verificador; si se borró, el gate perdió cobertura`);
    return null;
  }
  return fs.readFileSync(full, "utf8");
}

// Deriva "hoy" en UTC — el bug exacto que este gate impide reintroducir.
const UTC_TODAY_PATTERN = /toISOString\(\)\s*\.\s*(split\(\s*["']T["']\s*\)\s*\[\s*0\s*\]|slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\))/;

// ── 1. El módulo canónico ─────────────────────────────────────────────────────
{
  const src = readOrFail("src/lib/date/et.ts", BACKEND_ROOT);
  if (src) {
    for (const sym of ["getBusinessDateString", "etMidnightUtc", "BUSINESS_TIMEZONE"]) {
      if (!new RegExp(`export (function |const )?${sym}`).test(src) && !new RegExp(`export \\{[^}]*${sym}`).test(src)) {
        failures.push(`src/lib/date/et.ts: no exporta ${sym}`);
      }
    }
  }
}

// ── 2. TxnDate de QB — los 8 sitios, por NOMBRE ──────────────────────────────
const QB_TXN_DATE_SITES = [
  "src/api/admin/pos/sync/route.ts",
  "src/api/admin/invoices/[id]/void/route.ts",
  "src/api/admin/orders/[id]/post-edit-sync/route.ts",
  "src/jobs/qb-inventory-adjustment-poller.ts",
  "src/lib/quickbooks/client/inventory-adjustments.ts",
  "src/workflows/inventory-count/steps/enqueue-qb-adjustments-step.ts",
  "src/lib/quickbooks/damage/sync-damage-adjustment.ts",
  "src/scripts/fix/repair-dropped-inventory-count-deltas.ts",
];
for (const file of QB_TXN_DATE_SITES) {
  const src = readOrFail(file, BACKEND_ROOT);
  if (!src) continue;
  const code = codeLines(src);
  if (!/getBusinessDateString\s*\(/.test(code)) {
    failures.push(`${file}: no LLAMA a getBusinessDateString (un import solo no cuenta) — su fecha QB volvió a derivarse a mano`);
  }
  if (UTC_TODAY_PATTERN.test(code)) {
    failures.push(`${file}: reincidió en toISOString().split/slice — fecha UTC alimentando un documento QB`);
  }
}

// ── 3. Cortes de período en ET ────────────────────────────────────────────────
for (const file of ["src/lib/accounting/month-close-data.ts", "src/jobs/inventory-valuation-month-close.ts"]) {
  const src = readOrFail(file, BACKEND_ROOT);
  if (!src) continue;
  const code = codeLines(src);
  if (!/etMidnightUtc\s*\(/.test(code)) {
    failures.push(`${file}: no LLAMA a etMidnightUtc — el corte de período dejó de ser medianoche ET`);
  }
  if (UTC_TODAY_PATTERN.test(code)) {
    failures.push(`${file}: deriva una fecha con toISOString().split/slice (UTC)`);
  }
}

// ── 4. Treasury: nada de ::date crudo sobre timestamptz ─────────────────────
const TREASURY_FILES = [
  "src/api/admin/accounting/treasury/_lib/load-daily-report.ts",
  "src/api/admin/accounting/treasury/_lib/load-unattributed-payments.ts",
  "src/api/admin/accounting/treasury/_lib/load-sales-by-application.ts",
  "src/api/admin/accounting/treasury/_lib/load-cm-movements.ts",
  "src/api/admin/accounting/treasury/daily/log/route.ts",
  "src/api/admin/accounting/treasury/daily/defer-payment/route.ts",
  "src/api/admin/accounting/treasury/daily/payment-credit/resolve/route.ts",
  "src/api/admin/accounting/treasury/daily/cm-movement/resolve/route.ts",
];
for (const file of TREASURY_FILES) {
  const src = readOrFail(file, BACKEND_ROOT);
  if (!src) continue;
  const code = stripComments(src);
  const raw = code.match(/\b(received_at|applied_at)::date/g);
  if (raw) {
    failures.push(`${file}: ${raw.length}× ${[...new Set(raw)].join(", ")} crudo — el día de un timestamptz se resuelve en el TZ de sesión (UTC), no ET; usar batch_day o AT TIME ZONE 'America/New_York'`);
  }
}

// ── 5. store-pos: rangos ET vía lib/business-date ───────────────────────────
{
  const lib = readOrFail("lib/business-date.ts", POS_ROOT);
  if (lib) {
    for (const sym of ["BUSINESS_TIME_ZONE", "resolveRange", "etYmd"]) {
      if (!new RegExp(`export (function |const )?${sym}`).test(lib)) {
        failures.push(`store-pos/lib/business-date.ts: no exporta ${sym}`);
      }
    }
  }
  const picker = readOrFail("components/common/DateRangePicker.tsx", POS_ROOT);
  if (picker) {
    const code = stripComments(picker);
    if (!/from\s+['"]@\/lib\/business-date['"]/.test(code)) {
      failures.push(`store-pos DateRangePicker.tsx: no importa de lib/business-date — los rangos dejaron de ser ET`);
    }
    if (/(function|const)\s+resolveRange\s*[=(]/.test(code)) {
      failures.push(`store-pos DateRangePicker.tsx: volvió a tener un resolveRange LOCAL (zona del navegador)`);
    }
  }
  for (const file of ["app/(pos)/dashboard/page.tsx", "components/dashboard/TopProductsTable.tsx"]) {
    const src = readOrFail(file, POS_ROOT);
    if (!src) continue;
    const code = codeLines(stripComments(src));
    if (!/resolveRange\s*\(/.test(code)) {
      failures.push(`store-pos ${file}: no LLAMA a resolveRange — recreó su propia resolución de rango local`);
    }
  }
}

// ── Veredicto ─────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`✗ verify-et-business-dates: ${failures.length} falla(s)\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("✓ verify-et-business-dates: fechas de negocio ancladas a ET (QB TxnDate ×8, períodos ×2, Treasury ×8, POS ranges)");
