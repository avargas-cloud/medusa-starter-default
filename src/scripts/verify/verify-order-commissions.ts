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

// 9 · UNA sola derivación del monto de un beneficiario
//
// Desde que existe el modo 'fixed', "cuánto le toca" ya no es base × bps: una
// fila fija vale su monto y su % se deriva al revés. Hay DOS lectores del mismo
// dato (el modal de la orden y el listado de contabilidad) y si cada uno tiene
// su fórmula se contradicen en pantalla sin que nada falle — el patrón exacto
// que ya costó caro en el índice de órdenes y en el scope del Sales Pipeline.
// Por eso `recipientAmountCents` (la fórmula CRUDA por porcentaje) queda
// encapsulada dentro del calculador y todo lector pasa por `effectiveAmountCents`.
{
  const READERS = [
    "src/api/admin/commissions/orders/[orderId]/route.ts",
    "src/api/admin/commissions/route.ts",
  ];
  for (const rel of READERS) {
    const src = read(rel);
    check(
      `${rel.split("/").slice(-2).join("/")} deriva el monto con effectiveAmountCents`,
      src.includes("effectiveAmountCents")
    );
    check(
      `${rel.split("/").slice(-2).join("/")} NO usa la fórmula cruda recipientAmountCents`,
      !src.includes("recipientAmountCents")
    );
    check(
      `${rel.split("/").slice(-2).join("/")} sirve amount_mode al cliente`,
      src.includes("amount_mode")
    );
  }

  // El cap se mide en PORCENTAJE incluso para las filas fijas: si el escritor
  // dejara de convertirlas, un monto fijo sería la vía para saltear el tope.
  const writer = read("src/lib/commissions/writer.ts");
  check(
    "el escritor rechaza un monto fijo sobre base 0 (cap no evaluable)",
    writer.includes("undeterminedFixed") && writer.includes("fixed_amount_without_base")
  );
  check(
    "approve congela POR MODO, no reconstruyendo desde bps",
    writer.includes("effectiveAmountCents(asInt(row.base_cents)")
  );
}

console.log("");
if (failures.length > 0) {
  console.error(`❌ ${failures.length} chequeo(s) fallaron:`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log("✅ verify-order-commissions: todo registrado.");
