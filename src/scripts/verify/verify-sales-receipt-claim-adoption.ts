/**
 * Gate: el dispatcher del consolidator tiene que ADOPTAR la fila que él mismo
 * puso en `processing`, nunca re-reclamarla.
 *
 * Qué protege
 * -----------
 * `runPendingDispatchPass` marca la fila `processing` ANTES de invocar al
 * handler. `claimSalesReceiptAttempt` sólo sabe reusar filas `failed`, así que
 * sin la adopción el INSERT choca contra `uq_qb_pipeline_sales_receipt_live` y
 * el handler se skipea a sí mismo con `in_flight` — el ADD no sale NUNCA y la
 * fila cicla `processing → timeout 20min → failed → processing` para siempre.
 * Pasó en producción el 2026-08-17: el 100% de los sales receipts posteriores
 * al deploy de las 18:18 (3 de 3) se quedó fuera de QuickBooks sin un solo
 * badge rojo inmediato, mientras estimates y bill payment checks seguían
 * confirmando — o sea que ninguna señal agregada lo delataba.
 *
 * Por qué es estático y qué NO prueba
 * -----------------------------------
 * Esto valida el CABLEADO, no el comportamiento: que un `processing` real se
 * despache de punta a punta lo prueba el E2E de sandbox
 * (`e2e-sales-receipt-claim-adoption-sandbox.ts`), que corre el SQL contra un
 * Postgres de verdad. Los dos hacen falta: un unit test con pool falso nunca
 * ejecuta la query y no vería un `uuid = text` roto dentro de un catch.
 *
 * Correr:
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-sales-receipt-claim-adoption.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function check(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

// ── 1. El case del dispatcher pasa su propio rowId ──────────────────────────
{
  const src = read("lib/quickbooks/consolidator/resubmit-by-step.ts");
  const caseStart = src.indexOf('case "sales_receipt": {');
  // El corte va hasta la próxima ETIQUETA `case` — una que abre renglón. Usar
  // el primer `case "` a secas parte el cuerpo cuando un COMENTARIO nombra otro
  // case (pasó acá mismo: el comentario cita `case "estimate"`), que es la
  // misma fragilidad de ventana que ya dio un falso positivo el 2026-07-29.
  const rest = caseStart >= 0 ? src.slice(caseStart + 10) : "";
  const nextLabel = rest.search(/\n\s*case\s+"/);
  const body =
    caseStart >= 0
      ? src.slice(caseStart, nextLabel >= 0 ? caseStart + 10 + nextLabel : undefined)
      : "";

  check(
    "resubmit-by-step: existe el case sales_receipt",
    caseStart >= 0,
    caseStart >= 0 ? "encontrado" : "NO existe — el ADD no se despacha nunca"
  );
  check(
    "resubmit-by-step: el case pasa preclaimedRowId: row.id",
    /preclaimedRowId:\s*row\.id/.test(body),
    /preclaimedRowId:\s*row\.id/.test(body)
      ? "presente"
      : "AUSENTE — el handler va a re-reclamar y se va a auto-detectar in_flight"
  );
}

// ── 2. processSalesReceiptInQb adopta en vez de reclamar ────────────────────
{
  const src = read("lib/quickbooks/order-flow-core.ts");
  check(
    "order-flow-core: importa adoptSalesReceiptClaim",
    /adoptSalesReceiptClaim/.test(src),
    /adoptSalesReceiptClaim/.test(src) ? "presente" : "AUSENTE"
  );
  check(
    "order-flow-core: la adopción está gateada por preclaimedRowId",
    /receipt\.preclaimedRowId[\s\S]{0,120}adoptSalesReceiptClaim/.test(src),
    /receipt\.preclaimedRowId[\s\S]{0,120}adoptSalesReceiptClaim/.test(src)
      ? "el ternario elige adopción sólo cuando viene el rowId"
      : "AUSENTE — o adopta siempre (peligroso) o nunca (el deadlock)"
  );
}

// ── 3. La adopción verifica identidad Y estado ─────────────────────────────
{
  const src = read("lib/quickbooks/pipeline/claim-sales-receipt.ts");
  const fnStart = src.indexOf("export async function adoptSalesReceiptClaim");
  const body = fnStart >= 0 ? src.slice(fnStart, fnStart + 1600) : "";

  check(
    "claim: adoptSalesReceiptClaim existe",
    fnStart >= 0,
    fnStart >= 0 ? "encontrada" : "AUSENTE"
  );
  // Sin estos predicados un rowId equivocado emitiría un ADD contra otra fila,
  // que es minteear un documento duplicado en QuickBooks.
  for (const [label, re] of [
    ["order_id", /order_id\s*=\s*\$2/],
    ["reference_id", /reference_id\s*=\s*\$3/],
    ["step sales_receipt", /step\s*=\s*'sales_receipt'/],
    ["status processing", /status\s*=\s*'processing'/],
    ["bridge_op_id IS NULL", /bridge_op_id\s+IS\s+NULL/i],
  ] as [string, RegExp][]) {
    check(
      `claim: la adopción exige ${label}`,
      re.test(body),
      re.test(body) ? "presente" : `AUSENTE — adopta filas que no le tocan`
    );
  }
  check(
    "claim: no cae a un claim nuevo si la fila no matchea",
    /return\s*{\s*ok:\s*false,\s*reason:\s*"in_flight"\s*}/.test(body),
    /return\s*{\s*ok:\s*false,\s*reason:\s*"in_flight"\s*}/.test(body)
      ? "devuelve in_flight (fail-closed: ante la duda NO emite)"
      : "AUSENTE — un rowId malo podría terminar emitiendo un ADD duplicado"
  );
}

// ── Reporte ────────────────────────────────────────────────────────────────
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed++;
  console.log(`${c.pass ? "✅" : "❌"} ${c.name} — ${c.detail}`);
}
console.log(
  `\n${checks.length - failed}/${checks.length} checks OK${failed ? ` — ${failed} FALLARON` : ""}`
);
process.exit(failed > 0 ? 1 : 0);
