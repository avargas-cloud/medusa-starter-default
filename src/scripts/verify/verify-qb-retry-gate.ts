/**
 * verify-qb-retry-gate.ts — gate estático + funcional del retry gate del
 * botón admin "Retry" (`post-pipeline.ts` ← `lib/quickbooks/pipeline/retry-gate.ts`).
 *
 * Correr con:
 *   cd backend && env DISABLE_SCHEDULED_JOBS=true \
 *     DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-qb-retry-gate.ts
 *
 * (Va a imprimir los checks y después tirar el "File doesn't default export a
 * function to execute" preexistente de todos los scripts de esta carpeta —
 * no es un fallo de ESTE script.)
 *
 * Los checks 1-6 auditan el CABLEADO en `post-pipeline.ts` por posición en el
 * string (nunca sólo presencia) — la lección de vendor_bill_payment_check y
 * void_payment: un guard que corre en el orden equivocado, o que existe pero
 * nadie invoca, se ve idéntico a uno correcto en un grep superficial.
 *
 * Los checks 7-12 IMPORTAN el módulo real de `retry-gate.ts` y lo ejercitan
 * (es puro, sin IO) en vez de sólo leer texto — más fuerte que un scan.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import {
  ADD_CAPABLE_STEPS,
  PIPELINE_VERDICT_PATTERNS,
} from "../../lib/quickbooks/pipeline/retry-gate";

const ROOT = resolve(__dirname, "../../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}`);
  }
};

console.log("verify-qb-retry-gate — cableado + comportamiento del retry gate\n");

const POST_PIPELINE_REL =
  "src/api/admin/quickbooks/pipeline/handlers/post-pipeline.ts";
const RETRY_GATE_REL = "src/lib/quickbooks/pipeline/retry-gate.ts";

// ─────────────────────────────────────────────────────────────────────────
// 1-6 · cableado en post-pipeline.ts
// ─────────────────────────────────────────────────────────────────────────
{
  const src = read(POST_PIPELINE_REL);

  // 1. Importa evaluateRetryGate desde el módulo real.
  check(
    "post-pipeline importa evaluateRetryGate desde lib/quickbooks/pipeline/retry-gate",
    /import\s*\{\s*evaluateRetryGate\s*\}\s*from\s*"[^"]*lib\/quickbooks\/pipeline\/retry-gate"/.test(
      src
    )
  );

  // 2. Lo LLAMA en una línea VIVA (no comentada).
  const liveCallLines = src
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
      return trimmed.includes("evaluateRetryGate(");
    });
  check(
    "post-pipeline LLAMA evaluateRetryGate( en una línea viva",
    liveCallLines.length > 0
  );

  // 3. EL CHECK CRÍTICO — orden por posición: el gate corre ANTES del claim.
  //
  // El claim (`UPDATE ... SET status = 'pending', ..., bridge_op_id = NULL, ...`)
  // hace un RETURNING sobre la fila YA actualizada — bridge_op_id vuelve NULL
  // en el resultado. Si el gate leyera DESPUÉS del claim, jamás vería el
  // bridge_op_id real y no podría distinguir "este ADD puede ya existir en
  // QuickBooks" de "nunca salió de Medusa": el gate quedaría ciego justo en
  // el dato que existe para proteger.
  const gateCallIdx = src.indexOf("evaluateRetryGate(");
  const claimUpdateIdx = src.indexOf("SET status       = 'pending'");
  check(
    "el claim UPDATE ('SET status = pending') existe en post-pipeline",
    claimUpdateIdx >= 0
  );
  check(
    "evaluateRetryGate( corre ANTES del UPDATE que reclama la fila (bridge_op_id se pone NULL ahí — después, el gate ya no vería el valor real)",
    gateCallIdx >= 0 && claimUpdateIdx >= 0 && gateCallIdx < claimUpdateIdx
  );

  // 4. El SELECT que alimenta al gate pide las 5 columnas que necesita.
  const selectIdx = src.indexOf("SELECT step, status, error, bridge_op_id, qb_txn_id");
  check(
    "el SELECT que alimenta al gate pide step, status, error, bridge_op_id Y qb_txn_id",
    selectIdx >= 0
  );

  // 5. Deny → 409 + return, SIN tocar la fila (res.status(409) antes del claim).
  const denyBlockStart = src.indexOf("if (!verdict.allow)");
  const status409Idx = src.indexOf("res.status(409).json({", denyBlockStart >= 0 ? denyBlockStart : 0);
  check(
    "cuando el veredicto es deny, responde 409",
    denyBlockStart >= 0 && status409Idx > denyBlockStart
  );
  check(
    "el 409 de deny ocurre ANTES del UPDATE que reclama la fila (la fila queda intacta)",
    status409Idx >= 0 && claimUpdateIdx >= 0 && status409Idx < claimUpdateIdx
  );

  // 6. La respuesta de deny incluye code + instructions DEL VEREDICTO, no un
  // mensaje hardcodeado — deny409Body es el bloque del json() de esa rama.
  const deny409End = status409Idx >= 0 ? src.indexOf("});", status409Idx) : -1;
  const deny409Body =
    status409Idx >= 0 && deny409End >= 0 ? src.slice(status409Idx, deny409End) : "";
  check(
    "la respuesta de deny manda code: verdict.code e instructions: verdict.instructions",
    deny409Body.includes("code: verdict.code") &&
      deny409Body.includes("instructions: verdict.instructions") &&
      deny409Body.includes("error: verdict.reason")
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 7-12 · retry-gate.ts — ejercitado en vivo (módulo real, puro)
// ─────────────────────────────────────────────────────────────────────────

// 7. ADD_CAPABLE_STEPS = exactamente los 12 steps esperados, ni más ni menos.
{
  const expected = [
    "estimate",
    "sales_order",
    "invoice",
    "sales_receipt",
    "credit_memo",
    "payment",
    "apply_payment",
    "write_check",
    "item_receipt_add",
    "commission_check",
    "commission_payment",
    "vendor_bill_add",
  ].sort();
  const actual = [...ADD_CAPABLE_STEPS].sort();
  check(
    `ADD_CAPABLE_STEPS es exactamente [${expected.join(", ")}] (encontrado: [${actual.join(", ")}])`,
    expected.length === actual.length && expected.every((s, i) => s === actual[i])
  );
}

// 8. vendor_bill_payment_check NO está en ADD_CAPABLE_STEPS — load-bearing:
// las 78 filas retryables reales de producción son de ese step.
check(
  "vendor_bill_payment_check NO está en ADD_CAPABLE_STEPS (las 78 filas retryables reales de hoy son de ese step — bloquearlas rompería el único uso vivo del botón)",
  !(ADD_CAPABLE_STEPS as readonly string[]).includes("vendor_bill_payment_check")
);

// 9. Ningún patrón de PIPELINE_VERDICT_PATTERNS es una palabra suelta.
// Importado el módulo REAL (no una copia) — si algún patrón fuera laxo,
// dejaría pasar una falla de outcome desconocido SIN consultar al
// clasificador (branch 2 corre antes que branch 5).
{
  const looseWords = ["superseded", "voided", "skipped", "already", "no longer"];
  const matchedLoose = looseWords.filter((w) =>
    PIPELINE_VERDICT_PATTERNS.some((rx) => rx.test(w))
  );
  check(
    `ningún patrón de PIPELINE_VERDICT_PATTERNS matchea una palabra suelta (probadas: ${looseWords.join(", ")}) — un patrón laxo deja pasar una falla real sin pasar por decideAddRetrySafety${matchedLoose.length ? `; matchearon: ${matchedLoose.join(", ")}` : ""}`,
    matchedLoose.length === 0
  );
}

// 10. Los patrones SÍ reconocen las frases reales del pipeline.
{
  const realPhrases = [
    "Superseded by Invoice/Sales Receipt — Sales Order not needed",
    "apply_payment: payment_application voided (nothing to apply) — auto-skipped",
  ];
  const allMatch = realPhrases.every((phrase) =>
    PIPELINE_VERDICT_PATTERNS.some((rx) => rx.test(phrase))
  );
  check(
    "PIPELINE_VERDICT_PATTERNS reconoce las frases reales del pipeline (Superseded.../auto-skipped)",
    allMatch
  );
}

// 11. retry-gate.ts importa Y usa decideAddRetrySafety (reusa el clasificador
// existente, no lo duplica).
{
  const src = read(RETRY_GATE_REL);
  check(
    "retry-gate.ts importa decideAddRetrySafety desde ./add-retry-safety",
    /import\s*\{\s*decideAddRetrySafety\s*\}\s*from\s*"\.\/add-retry-safety"/.test(src)
  );
  const liveUse = src
    .split("\n")
    .some((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;
      return trimmed.includes("decideAddRetrySafety(") && !trimmed.startsWith("import");
    });
  check("retry-gate.ts LLAMA decideAddRetrySafety( en una línea viva (no sólo la importa)", liveUse);
}

// 12. retry-gate.ts es PURO: no importa nada de pg/db-pool ni hace query(.
{
  const src = read(RETRY_GATE_REL);
  const hasPgImport = /from\s*"pg"/.test(src) || /require\(\s*["']pg["']\s*\)/.test(src);
  const hasDbPoolImport = /db-pool/i.test(src);
  const hasQueryCall = /\bquery\s*\(/.test(src);
  check(
    "retry-gate.ts NO importa 'pg', NO importa db-pool, y NO llama query( — es una función pura sin IO",
    !hasPgImport && !hasDbPoolImport && !hasQueryCall
  );
}

console.log("");
if (failures.length > 0) {
  console.error(`❌ ${failures.length} chequeo(s) fallaron:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("✅ verify-qb-retry-gate: todo registrado.");
