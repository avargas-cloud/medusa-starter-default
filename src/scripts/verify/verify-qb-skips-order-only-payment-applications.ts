/**
 * verify-qb-skips-order-only-payment-applications.ts
 *
 * Static + dynamic guard for P6: order-only PaymentApplications
 * (invoice_id IS NULL) must NEVER be enqueued into the qb_order_pipeline
 * as apply_payment rows until the auto-rebind subscriber has populated
 * invoice_id.
 *
 * Layers:
 *   A) Static — handle-order-apply.ts must NOT contain writePipelineRow
 *      or enqueueApplyFin calls in the order-only branch.
 *   B) Static — handle-pos-payment-applied.ts must short-circuit when
 *      invoice_id is missing.
 *   C) Dynamic (sandbox) — confirm no qb_order_pipeline row exists with
 *      step='apply_payment' that references a PaymentApplication whose
 *      invoice_id IS NULL.
 *
 * Run:  yarn ts-node src/scripts/verify/verify-qb-skips-order-only-payment-applications.ts
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

import * as fs from "fs";
import * as path from "path";
import { Client } from "pg";

const ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

function assertContains(label: string, content: string, needle: string): boolean {
  const ok = content.includes(needle);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  return ok;
}

function assertNotContains(label: string, content: string, needle: string): boolean {
  const ok = !content.includes(needle);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  return ok;
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  const tick = (ok: boolean) => (ok ? pass++ : fail++);

  // ── Layer A: handle-order-apply.ts does not enqueue QB ───────────────
  console.log("\n[A] handle-order-apply.ts static guard");
  const helper = read("src/api/admin/finance/payments/[id]/apply/handle-order-apply.ts");
  tick(assertNotContains("does not call writePipelineRow", helper, "writePipelineRow"));
  tick(assertNotContains("does not call enqueueApplyFin", helper, "enqueueApplyFin"));
  tick(
    assertContains(
      "carries explicit invoice_id=null on the application",
      helper,
      "invoice_id: null"
    )
  );

  // ── Layer B: handle-pos-payment-applied.ts guards null invoice_id ────
  console.log("\n[B] handle-pos-payment-applied.ts null-invoice guard");
  const handler = read("src/lib/quickbooks/handlers/handle-pos-payment-applied.ts");
  tick(
    assertContains(
      "guard rejects missing invoice_id",
      handler,
      "if (!payment_id || !invoice_id || !order_id)"
    )
  );

  // ── Layer C: sandbox DB — no apply_payment row points at order-only PA
  console.log("\n[C] sandbox DB integrity");
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("5499")) {
    console.log("⊘ skipped — not running against sandbox");
  } else {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query(`
        SELECT qop.id AS row_id, qop.status, qop.reference_id, pa.invoice_id
        FROM qb_order_pipeline qop
        JOIN payment_application pa ON pa.id = qop.reference_id
        WHERE qop.step = 'apply_payment'
          AND pa.invoice_id IS NULL
          AND qop.status NOT IN ('cancelled', 'failed', 'voided')
        LIMIT 10
      `);
      const offenders = rows.length;
      tick(
        offenders === 0
          ? (console.log(
              `✓ no qb apply_payment rows with NULL invoice_id (active)`
            ),
            true)
          : (console.log(
              `✗ found ${offenders} apply_payment rows linked to order-only PAs (sample ids: ${rows.slice(0, 3).map((r) => r.row_id).join(", ")})`
            ),
            false)
      );
    } finally {
      await client.end();
    }
  }

  console.log(`\n[verify] RESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[verify] Fatal:", err);
  process.exit(2);
});
