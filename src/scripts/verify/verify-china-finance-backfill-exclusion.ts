/**
 * Verifica que China Finance nunca vuelva a registrar un `vendor_bill` creado
 * por el backfill QB→POS de compras (marcador `notes LIKE '[qb_backfill run=%'`,
 * `lib/qb-backfill/create-bill.ts`) como si fuera un documento pendiente con
 * VEETECH — el bug que produjo 34 filas / $73.280,53 "overdue" en prod
 * (2026-09-12) sobre bills que ya estaban pagados y conciliados en QuickBooks.
 *
 * ── Qué chequea ───────────────────────────────────────────────────────────────
 *   (a) DB: 0 filas de `china_finance_bill` apuntan (por `vendor_bill_id`) a un
 *       vendor_bill del backfill.
 *   (b) ESTRUCTURAL, por NOMBRE del predicado (`vendorBillNotBackfilledSql` /
 *       `vendorBillIsBackfilledSql`, `lib/china-finance/backfill-exclusion.ts`):
 *       cada query de auto-registro de `bills/route.ts` (`syncVeetchBills`, sus
 *       3 queries sobre `vendor_bill`) contiene el nombre del helper — barrido
 *       SOBRE EL CUERPO, con imports y comentarios REMOVIDOS primero (§4b/§4c
 *       de `.claude/rules/secrets.md`: un check que acepta el `import` o un
 *       comentario no prueba nada).
 *   (c) NO-VACUIDAD: en la DB hay ≥1 vendor_bill de VEETECH marcado como
 *       backfill. Si no hay ninguno, (a) no probó nada — se reporta INFO, no
 *       verde.
 *
 * ── Mutation test (obligatorio, documentado en el fix) ───────────────────────
 *   Quitar temporalmente `AND ${vendorBillNotBackfilledSql("vb")}` de la query
 *   "unlinked" en `bills/route.ts`, correr este verificador → (b) debe salir
 *   ROJO citando esa query. Restaurar y re-correr → verde.
 *
 * Run:
 *   DATABASE_URL=<url> ./node_modules/.bin/tsx src/scripts/verify/verify-china-finance-backfill-exclusion.ts
 *
 * Exit 0 = las tres cosas están bien (o (c) es INFO por falta de datos).
 * Exit 1 = alguna falló.
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const ROOT = process.cwd();
const failures: string[] = [];
const infos: string[] = [];

// ── (b) estructural — mismo patrón que verify-accounting-guard.ts ───────────
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:"'`])\/\/.*$/gm, "$1");
}

function stripImports(src: string): string {
  return src
    .replace(/^\s*import[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, " ")
    .replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, " ")
    .replace(/^\s*export\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?\s*$/gm, " ");
}

function bodyOf(relPath: string): string | null {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return stripImports(stripComments(fs.readFileSync(abs, "utf8")));
}

/**
 * `wire-transfers/*` no aparecen acá: leídos línea por línea, ninguno de sus
 * INSERT INTO china_finance_bill toma un `vendor_bill_id` (sólo
 * `opening_balance`/`bank_fee` sintéticos) y `[id]/credits/route.ts` consume
 * crédito derivado de un `china_finance_bill` ya existente, nunca crea uno
 * desde un `vendor_bill_id` explícito — si algún día alguno lo hiciera,
 * agregarlo acá.
 */
const PREDICATE_NAMES = ["vendorBillNotBackfilledSql", "vendorBillIsBackfilledSql"];

/**
 * Un `body.includes(predicateName)` a nivel de ARCHIVO ENTERO pasa en vacío
 * si el predicado sobrevive en 2 de 3 queries y se borró justo de la que
 * auto-registra (probado con mutation test: restaurar el predicado en las
 * queries de amount-sync/metadata-refresh y borrarlo SÓLO de la query
 * "unlinked" deja el archivo con el string presente en otro lado — un check
 * de archivo entero no lo detecta). Por eso cada query de `syncVeetchBills`
 * se acota entre marcadores ÚNICOS de su propio texto SQL y se exige el
 * predicado DENTRO de esa ventana, no en cualquier parte del archivo.
 */
type QueryWindow = { name: string; startMarker: string; endMarker: string; critical: boolean };

const BILLS_ROUTE = "src/api/admin/china-finance/bills/route.ts";

const BILLS_ROUTE_QUERY_WINDOWS: QueryWindow[] = [
  // Query 1: amount-sync CTE (line_totals) — actualiza montos de filas YA existentes.
  { name: "syncVeetchBills: amount-sync (line_totals)", startMarker: "WHERE vb.vendor_id = ?", endMarker: "SELECT cfb.id AS root_id", critical: false },
  // Query 2: metadata-refresh CTE (vendor_bill_totals) — actualiza display de filas YA existentes.
  { name: "syncVeetchBills: metadata-refresh (vendor_bill_totals)", startMarker: "WHERE vb.vendor_id = ?", endMarker: "UPDATE china_finance_bill cfb", critical: false },
  // Query 3 (CRÍTICA): el auto-registro real — INSERT de filas nuevas para VBs "unlinked".
  { name: "syncVeetchBills: unlinked (auto-register INSERT)", startMarker: "WHERE vb.vendor_id = ?", endMarker: "AND NOT EXISTS (", critical: true },
];

/** N-ésima ocurrencia (0-indexed) de `needle` en `haystack`, o -1. */
function nthIndexOf(haystack: string, needle: string, n: number): number {
  let idx = -1;
  for (let i = 0; i <= n; i++) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

function checkStructural(): void {
  const body = bodyOf(BILLS_ROUTE);
  if (body === null) {
    failures.push(`(b) ${BILLS_ROUTE}: archivo no encontrado`);
    return;
  }

  // Cada ventana usa la ocurrencia N de su startMarker (las 3 queries repiten
  // el mismo "WHERE vb.vendor_id = ?" literal, en orden de aparición).
  let startOccurrence = 0;
  for (const w of BILLS_ROUTE_QUERY_WINDOWS) {
    const startIdx = nthIndexOf(body, w.startMarker, startOccurrence);
    startOccurrence++;
    if (startIdx === -1) {
      failures.push(`(b) ${w.name}: no se encontró el marcador de inicio "${w.startMarker}" (ocurrencia ${startOccurrence}) — la query pudo haberse reescrito`);
      continue;
    }
    const endIdx = body.indexOf(w.endMarker, startIdx);
    if (endIdx === -1) {
      failures.push(`(b) ${w.name}: no se encontró el marcador de fin "${w.endMarker}" — no se puede acotar la ventana`);
      continue;
    }
    const window = body.slice(startIdx, endIdx);
    const hit = PREDICATE_NAMES.some((n) => window.includes(n));
    if (!hit) {
      failures.push(
        `(b) ${w.name}${w.critical ? " [CRÍTICA]" : ""}: no llama a ningún predicado de exclusión (${PREDICATE_NAMES.join(" / ")}) ` +
          `dentro de su propia query — un bill del backfill podría volver a entrar por acá`
      );
    }
  }
}

// ── (a) + (c) DB ──────────────────────────────────────────────────────────────
async function checkDb(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    failures.push("DATABASE_URL no está seteada");
    return;
  }
  const pool = new Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes("railway") || dbUrl.includes("sslmode") ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const backfilled = await pool.query(
      `SELECT id, number FROM vendor_bill
        WHERE notes LIKE '[qb_backfill run=%' AND deleted_at IS NULL`
    );
    if (backfilled.rowCount === 0) {
      infos.push(
        "(c) no hay ningún vendor_bill marcado como backfill en esta DB — (a) no prueba nada; " +
          "corré este verificador contra una DB con datos del backfill (o sembrá uno de prueba) antes de creerle"
      );
    } else {
      infos.push(`(c) vendor_bill del backfill en esta DB: ${backfilled.rowCount}`);
    }

    const leaked = await pool.query(
      `SELECT cfb.id, cfb.vendor_bill_id, vb.number AS vendor_bill_number, cfb.amount_cents
         FROM china_finance_bill cfb
         JOIN vendor_bill vb ON vb.id = cfb.vendor_bill_id
        WHERE vb.notes LIKE '[qb_backfill run=%'`
    );
    if ((leaked.rowCount ?? 0) > 0) {
      failures.push(
        `(a) ${leaked.rowCount} fila(s) de china_finance_bill apuntan a un vendor_bill del backfill: ` +
          leaked.rows.map((r) => `${r.id} (vb ${r.vendor_bill_number ?? r.vendor_bill_id}, $${(r.amount_cents / 100).toFixed(2)})`).join(", ")
      );
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  checkStructural();
  await checkDb();

  console.log("═".repeat(72));
  console.log("verify-china-finance-backfill-exclusion");
  console.log("═".repeat(72));
  for (const i of infos) console.log(`INFO  ${i}`);
  if (failures.length === 0) {
    console.log("OK — sin filas de china_finance_bill del backfill, y el predicado de exclusión está en su lugar.");
    process.exit(0);
  }
  for (const f of failures) console.log(`FAIL  ${f}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
