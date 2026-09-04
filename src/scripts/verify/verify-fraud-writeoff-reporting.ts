/**
 * verify-fraud-writeoff-reporting.ts — gate de la exclusión del write-off por fraude.
 *
 * Correr:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-fraud-writeoff-reporting.ts
 *
 * Script tsx PLANO, sin `export default`, por la misma razón que
 * `verify-reports-revenue.ts`: un verify con export default corrido por tsx no
 * ejecuta nada y sale 0, o sea un gate que aprueba en silencio.
 *
 * ── Qué protege ──────────────────────────────────────────────────────────────
 *
 * Un credit memo de write-off por fraude no es una devolución: la mercadería no
 * volvió y en QuickBooks la pérdida va a una cuenta de gasto sin tocar las
 * ventas. Si nuestros reportes lo cuentan como refund, restan de las ventas una
 * plata que QB cuenta como gasto, y los dos sistemas dejan de coincidir.
 *
 * La reversión de devoluciones NO está centralizada: de las 20 queries que
 * miran `pos_credit_memo` en las superficies de reporte, sólo 4 pasan por
 * `CM_REFUND_SCOPE_SQL`; las otras 16 inlinean el scope a mano. Por eso el
 * chequeo central de este gate es ESTRUCTURAL: cualquier query NUEVA que trate
 * un credit memo como devolución y se olvide del predicado tiene que ponerse en
 * rojo acá. Enumerar los sitios a mano fue confiable UNA vez; el que agregue el
 * reporte 21 no va a leer esta nota.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

import {
  CM_REPORTING_TREATMENT_KEY,
  CM_TREATMENT_FRAUD_WRITEOFF,
  cmNotFraudWriteoffSql,
} from "../../lib/reports/fraud-writeoff";
import { CM_REFUND_SCOPE_SQL } from "../../api/admin/reports/_lib/sales-revenue";

const API_ROOT = join(__dirname, "..", "..", "api", "admin");

/** Superficies donde un credit memo significa "devolución" para un reporte. */
const REPORTING_DIRS = ["reports", "invoices", "dashboard"];

/**
 * Marcadores que acreditan que una query excluye el write-off: la llamada
 * directa al helper, o la constante compartida (que ya lo contiene y está
 * asertada aparte, abajo).
 */
const MARKERS = ["cmNotFraudWriteoffSql(", "CM_REFUND_SCOPE_SQL"];

/** Líneas hacia adelante en las que se acepta ver el marcador. */
const LOOKAHEAD = 20;

type Violation = { file: string; line: number };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function scanStructural(): { checked: number; violations: Violation[] } {
  const violations: Violation[] = [];
  let checked = 0;

  for (const d of REPORTING_DIRS) {
    for (const file of walk(join(API_ROOT, d))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/FROM\s+pos_credit_memo\b/.test(line)) return;
        checked++;
        const window = lines.slice(i, i + LOOKAHEAD).join("\n");
        if (!MARKERS.some((m) => window.includes(m))) {
          violations.push({ file: file.replace(API_ROOT, "admin"), line: i + 1 });
        }
      });
    }
  }
  return { checked, violations };
}

let failed = 0;
const fail = (msg: string) => {
  console.error(`❌ ${msg}`);
  failed++;
};
const pass = (msg: string) => console.log(`✅ ${msg}`);

console.log("── verify-fraud-writeoff-reporting ──\n");

// ── 1 · La constante compartida realmente lleva el predicado ────────────────
// Se importa la constante REAL, no una copia: si alguien la edita y saca la
// exclusión, esto se pone rojo. Un gate que reimplementa lo que vigila deja de
// vigilar el día que la fórmula cambia.
if (CM_REFUND_SCOPE_SQL.includes(CM_TREATMENT_FRAUD_WRITEOFF)) {
  pass("CM_REFUND_SCOPE_SQL excluye el write-off por fraude");
} else {
  fail(
    "CM_REFUND_SCOPE_SQL YA NO excluye el write-off — los 12 reportes que la " +
      "usan volvieron a contar el fraude como devolución"
  );
}

// ── 2 · El predicado tolera metadata ausente ────────────────────────────────
// Sin el COALESCE, el predicado evalúa NULL para todo memo sin metadata (o sea
// todos los históricos) y los excluye a TODOS: invierte el bug en vez de
// arreglarlo, y de forma silenciosa porque el reporte simplemente da menos.
const predicate = cmNotFraudWriteoffSql("cm");
if (predicate.includes("COALESCE(") && predicate.includes(CM_REPORTING_TREATMENT_KEY)) {
  pass("el predicado usa COALESCE — los memos sin metadata siguen contando");
} else {
  fail(
    `el predicado perdió el COALESCE: "${predicate}" — un memo sin metadata ` +
      "evaluaría NULL y quedaría excluido de las devoluciones"
  );
}

// ── 3 · Gate estructural ────────────────────────────────────────────────────
const { checked, violations } = scanStructural();
if (checked === 0) {
  // Sin esto, un cambio de layout de directorios dejaría el gate barriendo el
  // vacío y aprobando por no encontrar nada — el modo de falla más caro.
  fail(
    "el scan no encontró NINGUNA query sobre pos_credit_memo — el gate está " +
      "mirando al lugar equivocado, no es que esté todo bien"
  );
} else if (violations.length === 0) {
  pass(
    `${checked} queries sobre pos_credit_memo en reportes, todas excluyen el write-off`
  );
} else {
  fail(
    `${violations.length} de ${checked} queries tratan un credit memo como ` +
      "devolución SIN excluir el write-off por fraude:"
  );
  for (const v of violations) console.error(`     ${v.file}:${v.line}`);
  console.error(
    `     → agregar: AND \${cmNotFraudWriteoffSql("<alias>")} al WHERE`
  );
}

console.log(
  failed === 0 ? "\n✅ VERDE" : `\n❌ ROJO — ${failed} chequeo(s) fallaron`
);
process.exit(failed === 0 ? 0 : 1);
