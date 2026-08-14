/**
 * verify-order-commissions.ts — gate estático del Commissions Pipeline.
 *
 * Correr con: ./node_modules/.bin/tsx src/scripts/verify/verify-order-commissions.ts
 *
 * Afirma POR NOMBRE que los dos steps del lane (`commission_check`,
 * `commission_payment`) están registrados en cada lector que los necesita —
 * la lección del vendor_bill_payment_check (3 lectores del scope) y del
 * void_payment (case sin listas de dispatch = fila pending eterna):
 *
 *   1. runPendingDispatchPass los reclama (lista de steps).
 *   2. resubmit-by-step tiene case propio para cada uno, y ese case llama al
 *      handler (escaneo hasta el próximo `case "` — nunca ventana fija).
 *   3. poll-submitted-rows tiene hook de confirm para cada uno.
 *   4. sales-pipeline-scope los EXCLUYE del Sales Pipeline vía
 *      COMMISSION_PIPELINE_STEPS dentro de SALES_PIPELINE_EXCLUDED_STEPS.
 *   5. PipelineStep (types) los tipa.
 *   6. El handler manda Idempotency-Key 1:1 por fila y el payment leg pasa
 *      depositAccount (el invariante clearing=$0 depende de eso).
 *   7. El allowlist de bills service acepta la cuenta de comisión (caso 1).
 *   8. La ruta de settle exige method y compensa el post-commit fallado.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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

const STEPS = ["commission_check", "commission_payment"] as const;

console.log("verify-order-commissions — registro del Commissions Pipeline\n");

// 1 · dispatch-pass
{
  const src = read("src/lib/quickbooks/consolidator/dispatch-pass.ts");
  for (const step of STEPS) {
    check(`dispatch-pass reclama '${step}'`, src.includes(`'${step}'`));
  }
}

// 2 · resubmit-by-step: case propio que invoca el handler correcto
{
  const src = read("src/lib/quickbooks/consolidator/resubmit-by-step.ts");
  const caseBody = (step: string): string | null => {
    const label = `case "${step}":`;
    const start = src.indexOf(label);
    if (start < 0) return null;
    // Hasta la PRÓXIMA etiqueta case — saltando labels apilados vacíos.
    let cursor = start + label.length;
    for (;;) {
      const next = src.indexOf(`case "`, cursor);
      const body = src.slice(start, next < 0 ? undefined : next);
      if (body.replace(label, "").trim().length > 0 || next < 0) return body;
      cursor = next + 6;
    }
  };
  const checkBody = caseBody("commission_check");
  check(
    "resubmit-by-step case commission_check → dispatchCommissionCheck",
    !!checkBody && checkBody.includes("dispatchCommissionCheck")
  );
  const payBody = caseBody("commission_payment");
  check(
    "resubmit-by-step case commission_payment → dispatchCommissionPayment",
    !!payBody && payBody.includes("dispatchCommissionPayment")
  );
}

// 3 · poller: hooks de confirm
{
  const src = read("src/lib/quickbooks/consolidator/poll-submitted-rows.ts");
  check(
    "poller estampa settlement al confirmar commission_check",
    src.includes(`row.step === "commission_check"`) &&
      src.includes("qb_check_txn_id")
  );
  check(
    "poller cierra settlement+recipient al confirmar commission_payment",
    src.includes(`row.step === "commission_payment"`) &&
      src.includes("qb_payment_txn_id") &&
      src.includes("state = 'closed'")
  );
}

// 4 · scope: excluidos del Sales Pipeline
{
  const src = read("src/lib/quickbooks/pipeline/sales-pipeline-scope.ts");
  check(
    "COMMISSION_PIPELINE_STEPS exportado con ambos steps",
    src.includes("COMMISSION_PIPELINE_STEPS") &&
      STEPS.every((s) => src.includes(`"${s}"`))
  );
  const excludedBlock = src.slice(src.indexOf("SALES_PIPELINE_EXCLUDED_STEPS"));
  // Línea VIVA (no comentada): un `// ...COMMISSION_PIPELINE_STEPS` también
  // contiene el string — la mutación que este check tiene que cazar.
  const liveSpread = excludedBlock
    .split("\n")
    .some((line) => line.trim().startsWith("...COMMISSION_PIPELINE_STEPS"));
  check("COMMISSION_PIPELINE_STEPS dentro de SALES_PIPELINE_EXCLUDED_STEPS", liveSpread);
}

// 5 · tipos
{
  const src = read("src/lib/quickbooks/pipeline/types.ts");
  for (const step of STEPS) {
    check(`PipelineStep tipa '${step}'`, src.includes(`| "${step}"`));
  }
}

// 6 · handler: idempotencia 1:1 + depositAccount
{
  const src = read("src/lib/quickbooks/handlers/handle-commission-settlement.ts");
  check(
    "check leg manda Idempotency-Key commission-check:<rowId>",
    src.includes("`commission-check:${row.id}`")
  );
  check(
    "payment leg manda Idempotency-Key commission-payment:<rowId>",
    src.includes("`commission-payment:${row.id}`")
  );
  check(
    "payment leg pasa depositAccount (clearing) y autoApply:false",
    src.includes("depositAccount") && src.includes("autoApply: false")
  );
}

// 7 · allowlist de bills service (caso 1)
{
  const src = read("src/lib/purchase-orders/vendor-bill-account-rules.ts");
  check(
    "bills service aceptan 'commission for sale:referral'",
    src.includes(`"commission for sale:referral"`)
  );
}

// 8 · ruta de settle: compensación del post-commit
{
  const src = read(
    "src/api/admin/commissions/orders/[orderId]/recipients/[recipientId]/route.ts"
  );
  check(
    "settle exige method vendor_bill|store_credit",
    src.includes(`"vendor_bill"`) && src.includes(`"store_credit"`)
  );
  check(
    "post-commit fallado COMPENSA (settlement failed + recipient approved)",
    src.includes("settle_enqueue_failed") && src.includes("state = 'approved'")
  );
}

console.log("");
if (failures.length > 0) {
  console.error(`❌ ${failures.length} chequeo(s) fallaron:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("✅ verify-order-commissions: todo registrado.");
