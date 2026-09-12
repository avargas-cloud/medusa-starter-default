/**
 * Verifica que Accounting y Admin Tools sigan siendo autorizaciones REALES.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * Hasta el 2026-09-10 la regla era "usuario de Medusa ausente de `pos_user` ⇒
 * puede TODO", y seis pantallas de Accounting no tenían NINGÚN guard de
 * servidor: el gate vivía en React. Un gate abierto y uno cerrado se ven
 * exactamente igual desde la UI, así que nada de eso rompía un test.
 *
 * Afirma por NOMBRE (listas cerradas), no por lo que el archivo mencione: la
 * 5ª extensión de `.claude/rules/secrets.md` documenta que mirar sólo los
 * archivos que NOMBRAN la clave es ciego a la falla inversa. Y busca la LLAMADA
 * con imports y comentarios YA REMOVIDOS: la 6ª extensión cuenta cómo un check
 * sobre el texto completo se conformaba con que el archivo IMPORTARA el guard.
 *
 * ── Qué chequea ───────────────────────────────────────────────────────────────
 *   1. cada ruta de MUST_REQUIRE_ACCOUNTING existe y llama a su guard
 *   2. cada ruta de MUST_REQUIRE_OWNER existe y llama a assertOwner
 *   3. los helpers delegantes (month-close, trip-objectives, inventory-counts)
 *      resuelven de verdad contra lib/pos/access-level — si no, las listas que
 *      dependen de ellos serían vacías
 *   4. barrido ESTRUCTURAL: toda route.ts bajo los directorios sensibles tiene
 *      que estar declarada en alguna lista. Un archivo nuevo sin declarar falla.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-accounting-guard.ts
 */
import fs from "node:fs";
import path from "node:path";

const ADMIN = path.join(process.cwd(), "src/api/admin");
const failures: string[] = [];
const notes: string[] = [];

/** Comentarios fuera: un docstring que NOMBRA el guard no es un guard. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:"'`])\/\/.*$/gm, "$1");
}

/** Imports y re-exports fuera: importar el guard no es llamarlo. */
function stripImports(src: string): string {
  return src
    .replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, " ")
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, " ")
    .replace(/^\s*export\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\s*$/gm, " ");
}

function body(rel: string): string | null {
  const abs = path.join(ADMIN, rel);
  if (!fs.existsSync(abs)) return null;
  return stripImports(stripComments(fs.readFileSync(abs, "utf8")));
}

type Entry = { file: string; call: string; why: string };

/**
 * Rutas que exigen acceso a Accounting. Las que llaman al guard directo usan
 * `assertAccounting` de `lib/pos/access-level`; las otras tres familias llegan
 * por un helper delegante y por eso se afirma el NOMBRE DEL HELPER que la ruta
 * llama (el chequeo 3 prueba que ese helper delega de verdad).
 */
const MUST_REQUIRE_ACCOUNTING: Entry[] = [
  ...[
    "accounting/treasury/daily/route.ts",
    "accounting/treasury/daily/log/route.ts",
    "accounting/treasury/daily/defer-payment/route.ts",
    "accounting/treasury/daily/cm-movement/resolve/route.ts",
    "accounting/treasury/daily/payment-credit/resolve/route.ts",
    "accounting/treasury/buckets/route.ts",
    "accounting/treasury/buckets/[id]/route.ts",
    "finance/qb-refunds/pending/route.ts",
    "finance/qb-refunds/sync/route.ts",
    "finance/qb-refunds/mod/route.ts",
    "finance/qb-refunds/[id]/void/route.ts",
    "finance/qb-refunds/[id]/revert/route.ts",
    "finance/qb-refunds/[id]/confirm-qb-cleanup/route.ts",
    "pos/price-batches/[id]/approve/route.ts",
    "pos/price-batches/[id]/reject/route.ts",
  ].map((file) => ({ file, call: "assertAccounting(", why: "guard directo" })),
  ...[
    "accounting/month-close/route.ts",
    "accounting/month-close/reopen/route.ts",
    "accounting/month-close/reopen-preview/route.ts",
    "accounting/month-close/resolve-delta/route.ts",
    "accounting/month-close/reverse-adjustment/route.ts",
    "reports/profit-loss/payroll/route.ts",
    "accounting/payables/route.ts",
    "accounting/ledger/account-map/route.ts",
    "accounting/ledger/entries/route.ts",
    "accounting/ledger/trial-balance/route.ts",
    "accounting/ledger/opening-balances/route.ts",
    "accounting/ledger/opening-balances/evidence/route.ts",
    "accounting/ledger/opening-balances/[accountListId]/reverse/route.ts",
  ].map((file) => ({
    file,
    call: "requireFullAdmin(",
    why: "delega en lib/accounting/month-close-auth.ts",
  })),
  ...[
    "accounting/ledger/register/route.ts",
    "accounting/ledger/profit-loss/route.ts",
    "accounting/ledger/balance-sheet/route.ts",
    "accounting/ledger/sales-tax/route.ts",
    "accounting/accounts/route.ts",
  ].map((file) => ({
    file,
    call: "requireAccountingOr403(",
    why: "delega en lib/ledger/reports/route-common.ts (GL reports; accounts POST exige además assertOwner)",
  })),
  /**
   * E1 (gl-documents): las rutas de documentos del GL. Si todavía no existen
   * en este árbol el chequeo 1 lo dice ("NO EXISTE") — una lista que apunta a
   * la nada aprueba en vacío, así que se declaran por NOMBRE desde ya.
   */
  ...[
    "accounting/journal-entries/route.ts",
    "accounting/journal-entries/[id]/route.ts",
    "accounting/journal-entries/[id]/post/route.ts",
    "accounting/journal-entries/[id]/void/route.ts",
    "accounting/checks/route.ts",
    "accounting/checks/[id]/route.ts",
    "accounting/checks/[id]/post/route.ts",
    "accounting/checks/[id]/void/route.ts",
    "accounting/transfers/route.ts",
    "accounting/transfers/[id]/route.ts",
    "accounting/transfers/[id]/post/route.ts",
    "accounting/transfers/[id]/void/route.ts",
    "accounting/ledger/year-close/route.ts",
    "accounting/ledger/year-close/reverse/route.ts",
  ].map((file) => ({
    file,
    call: "assertAccounting(",
    why: "documentos del GL (E1) — guard directo",
  })),
  ...[
    "inventory-counts/[id]/approve/route.ts",
    "inventory-counts/[id]/reject/route.ts",
    "inventory-counts/[id]/preview-approval/route.ts",
    "inventory-counts/[id]/void/route.ts",
  ].map((file) => ({
    file,
    call: "requireManager(",
    why: "delega en inventory-counts/_lib/auth.ts",
  })),
  ...[
    "trip-objectives/trips/route.ts",
    "trip-objectives/categories/route.ts",
    "trip-objectives/categories/[id]/route.ts",
    "trip-objectives/objectives/route.ts",
    "trip-objectives/objectives/[id]/route.ts",
    "trip-objectives/objectives/[id]/observations/route.ts",
    "trip-objectives/observations/[id]/route.ts",
    "commissions/route.ts",
    "commissions/settings/route.ts",
    "commissions/summary-1099/route.ts",
    "commissions/customer-vendor-link/route.ts",
    "commissions/orders/[orderId]/route.ts",
    "commissions/orders/[orderId]/recipients/[recipientId]/route.ts",
    "outsourced-services/route.ts",
    "outsourced-services/types/route.ts",
    "outsourced-services/orders/[orderId]/route.ts",
    "outsourced-services/orders/[orderId]/services/[serviceId]/route.ts",
  ].map((file) => ({
    file,
    call: "assertAccounting(",
    why: "delega en trip-objectives/_lib/guard.ts",
  })),
];

/** Pantallas de Admin Tools: owner y nadie más. */
const MUST_REQUIRE_OWNER: Entry[] = [
  // Herramientas de la era QuickBooks (Import QB Credit · Match QB Bills): pasaron
  // de Accounting a System Tools el 2026-09-12 — sólo el owner.
  "quickbooks/bill-match/candidates/route.ts",
  "quickbooks/bill-match/candidates-by-vendor/route.ts",
  "quickbooks/bill-match/unbilled-pos/route.ts",
  "quickbooks/bill-match/adopt/route.ts",
  "quickbooks/bill-match/undo/route.ts",
  "quickbooks/customer-credits/route.ts",
  "quickbooks/customer-credits/import/route.ts",
  "pos-users/route.ts",
  "pos-users/[id]/route.ts",
  "pos-users/invite/route.ts",
  "pos-accounting-access/route.ts",
  "email-marketing/activity/route.ts",
  "email-marketing/overview/route.ts",
  "quickbooks/lookup/route.ts",
  "quickbooks/medusa-search/route.ts",
  "quickbooks/metadata/route.ts",
  "quickbooks/search-by-date/route.ts",
  "quickbooks/search-payments/route.ts",
  "quickbooks/sync/avg-cost-run/route.ts",
  "quickbooks/customer/create-and-sync/route.ts",
  "qb-catalog/accounts/sync/route.ts",
  "search/customers/sync/route.ts",
  "search/inventory/sync/route.ts",
  "search/invoices/sync/route.ts",
  "search/orders/sync/route.ts",
  "search/products/sync/route.ts",
  "search/vendors/sync/route.ts",
  "settings/payment-batch-cutoff/route.ts",
  "settings/shipping-dispatch-provider/route.ts",
  "accounting/accounts/[listId]/route.ts",
].map((file) => ({ file, call: "assertOwner(", why: "pantalla de Admin Tools" }));

// ── 1 + 2 · cada ruta declarada llama a su guard ─────────────────────────────
function checkList(entries: Entry[], label: string): void {
  let ok = 0;
  for (const entry of entries) {
    const src = body(entry.file);
    if (src === null) {
      failures.push(
        `api/admin/${entry.file} NO EXISTE y está declarada en ${label}. ` +
          `Si la ruta se movió o se borró, actualizá la lista EN EL MOMENTO: ` +
          `una lista que apunta a la nada aprueba en vacío.`
      );
      continue;
    }
    if (!src.includes(entry.call)) {
      failures.push(
        `api/admin/${entry.file} no llama a ${entry.call}) fuera de imports y ` +
          `comentarios (${entry.why}). Sin esa llamada la ruta contesta 200 a ` +
          `cualquier token del POS — todo cajero es usuario admin de Medusa.`
      );
      continue;
    }
    ok++;
  }
  if (ok === entries.length) {
    notes.push(`✓ ${ok} ruta(s) de ${label} llaman a su guard`);
  }
}

checkList(MUST_REQUIRE_ACCOUNTING, "MUST_REQUIRE_ACCOUNTING");
checkList(MUST_REQUIRE_OWNER, "MUST_REQUIRE_OWNER");

// ── 3 · los helpers delegantes delegan de verdad ─────────────────────────────
const DELEGATES: Array<{ file: string; calls: string[] }> = [
  {
    file: "src/lib/accounting/month-close-auth.ts",
    calls: ["assertAccounting("],
  },
  {
    file: "src/api/admin/trip-objectives/_lib/guard.ts",
    calls: ["assertAccessAccounting(", "resolveAccessLevel("],
  },
  {
    file: "src/api/admin/inventory-counts/_lib/auth.ts",
    calls: ["assertAccounting("],
  },
  {
    file: "src/lib/ledger/reports/route-common.ts",
    calls: ["assertAccounting("],
  },
];
let delegatesOk = 0;
for (const delegate of DELEGATES) {
  const abs = path.join(process.cwd(), delegate.file);
  if (!fs.existsSync(abs)) {
    failures.push(`${delegate.file} NO EXISTE: las rutas que delegan en él no están gateadas.`);
    continue;
  }
  const raw = fs.readFileSync(abs, "utf8");
  const src = stripImports(stripComments(raw));
  if (!/lib\/pos\/access-level/.test(raw)) {
    failures.push(
      `${delegate.file} ya no resuelve contra lib/pos/access-level. Si vuelve ` +
        `a decidir por su cuenta ("ausente de pos_user ⇒ allow"), las ${MUST_REQUIRE_ACCOUNTING.length} ` +
        `rutas que delegan en él quedan abiertas sin que cambie una sola línea de ellas.`
    );
    continue;
  }
  if (!delegate.calls.some((call) => src.includes(call))) {
    failures.push(
      `${delegate.file} importa access-level pero no lo LLAMA (${delegate.calls.join(" / ")}). ` +
        `Importar no autoriza: es la falla que documenta la 6ª extensión de secrets.md.`
    );
    continue;
  }
  delegatesOk++;
}
if (delegatesOk === DELEGATES.length) {
  notes.push(`✓ los ${delegatesOk} helpers delegantes resuelven contra lib/pos/access-level`);
}

// ── 3b · lo declarado ABIERTO, con su motivo ────────────────────────────────
/**
 * Una ruta sin guard bajo un directorio sensible es una DECISIÓN o es un
 * olvido, y desde afuera se ven igual. Declararla acá la convierte en decisión;
 * el chequeo comprueba además que siga siendo lo que dice ser.
 */
const DECLARED_OPEN = [
  {
    file: "pos-accounting-access/me/route.ts",
    reexport: 'export { GET } from "../../pos-access/me/route";',
    why:
      "alias de GET /admin/pos-access/me: contesta el nivel del PROPIO usuario " +
      "autenticado. Gatearlo dejaría a la pantalla sin poder saber qué dibujar",
  },
];
for (const open of DECLARED_OPEN) {
  const abs = path.join(ADMIN, open.file);
  const raw = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  if (raw === null) continue; // el barrido estructural no lo va a encontrar
  const rest = stripImports(stripComments(raw)).trim();
  if (!raw.includes(open.reexport) || rest.length > 0) {
    failures.push(
      `api/admin/${open.file} está declarada ABIERTA (${open.why}) pero dejó ` +
        `de ser un re-export puro. Si ahora tiene lógica propia, necesita su ` +
        `guard y su lugar en una de las dos listas.`
    );
  }
}

// ── 4 · barrido estructural: nada nuevo entra sin declararse ─────────────────
const SWEPT_DIRS = [
  "accounting",
  "finance/qb-refunds",
  "quickbooks/bill-match",
  "quickbooks/customer-credits",
  "pos-users",
  "pos-accounting-access",
];
const declared = new Set([
  ...[...MUST_REQUIRE_ACCOUNTING, ...MUST_REQUIRE_OWNER].map((e) => e.file),
  ...DECLARED_OPEN.map((e) => e.file),
]);

function walkRoutes(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkRoutes(full, out);
    else if (e.name === "route.ts") out.push(path.relative(ADMIN, full));
  }
}

let sweptOk = 0;
for (const dir of SWEPT_DIRS) {
  const found: string[] = [];
  walkRoutes(path.join(ADMIN, dir), found);
  if (found.length === 0) {
    failures.push(
      `el barrido de api/admin/${dir} no encontró NINGUNA route.ts. Un barrido ` +
        `vacío pasa siempre: o el directorio se renombró, o este verificador ` +
        `dejó de mirar donde vive el código.`
    );
    continue;
  }
  for (const rel of found) {
    if (!declared.has(rel)) {
      failures.push(
        `api/admin/${rel} es una ruta NUEVA sin declarar. Toda ruta bajo ` +
          `api/admin/${dir} tiene que estar en MUST_REQUIRE_ACCOUNTING o en ` +
          `MUST_REQUIRE_OWNER con su guard: el default de este dominio es ` +
          `"gateada", y una ruta que nadie declaró es una que nadie miró.`
      );
    }
  }
  sweptOk += found.length;
}
if (!failures.some((f) => f.includes("sin declarar") || f.includes("barrido de"))) {
  notes.push(`✓ las ${sweptOk} rutas de los directorios sensibles están declaradas`);
}

// ── Reporte ─────────────────────────────────────────────────────────────────
console.log("=== verify-accounting-guard ===\n");
for (const n of notes) console.log("  " + n);

if (failures.length > 0) {
  console.error(`\n❌ ${failures.length} problema(s):\n`);
  for (const f of failures) console.error("  • " + f + "\n");
  process.exit(1);
}
console.log(`\n✅ Accounting y Admin Tools siguen siendo autorizaciones reales`);
