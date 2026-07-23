/**
 * scripts/fix/remediate-zero-amount-anchor-payments.ts
 *
 * Cleans up the $0 "anchor payment" anti-pattern left behind by
 * ApplyCreditModal (see verify-zero-amount-payment-qb-guard.ts for the why).
 *
 * For every active $0 customer_payment, in ONE transaction per payment:
 *   1. Move its checkout-event metadata onto the payment_application it
 *      describes (payment_application.metadata — the canonical home since
 *      Migration20260518130000). Only fills a NULL metadata; never overwrites.
 *   2. Mark its non-terminal QB `payment` pipeline row as 'skipped' with a
 *      reason, breaking the processing→timeout→failed→retry loop.
 *   3. Soft-delete the $0 payment (deleted_at = NOW()).
 *
 * The target application is resolved from metadata.credits_consumed[].payment_id
 * + metadata.invoices_affected[] — i.e. the real credit payment and the invoice
 * it was applied to. If it can't be resolved unambiguously, the payment is
 * SKIPPED and reported, never guessed.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to actually write.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/fix/remediate-zero-amount-anchor-payments.ts
 *      ./node_modules/.bin/tsx src/scripts/fix/remediate-zero-amount-anchor-payments.ts --apply
 */

import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

const APPLY = process.argv.includes("--apply");
const NON_TERMINAL = ["pending", "processing", "submitted", "waiting"];
const SKIP_REASON =
  "$0 anchor payment — nothing to record in QB (credit applied via its own apply_payment row)";

type AnchorRow = {
  payment_id: string;
  display_id: number;
  metadata: Record<string, unknown> | null;
};

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log(
    APPLY
      ? "⚠️  APPLY MODE — changes WILL be written.\n"
      : "🔎 DRY RUN — no changes will be written. Pass --apply to commit.\n"
  );

  let remediated = 0;
  let skipped = 0;

  try {
    const { rows: anchors } = await client.query<AnchorRow>(
      `SELECT id AS payment_id, display_id, metadata
         FROM customer_payment
        WHERE amount = 0
          AND deleted_at IS NULL
        ORDER BY created_at`
    );

    if (anchors.length === 0) {
      console.log("Nothing to do — zero $0 payments alive.");
      return;
    }

    console.log(`Found ${anchors.length} $0 payment(s).\n`);

    for (const anchor of anchors) {
      const md = (anchor.metadata ?? {}) as Record<string, any>;
      const label = `PAY-${anchor.display_id} (${anchor.payment_id})`;
      console.log(`── ${label}`);

      // Resolve the payment_application this anchor was describing.
      const creditPaymentIds: string[] = Array.isArray(md.credits_consumed)
        ? md.credits_consumed
            .map((c: any) => c?.payment_id)
            .filter((v: unknown): v is string => typeof v === "string")
        : [];
      const invoiceIds: string[] = Array.isArray(md.invoices_affected)
        ? md.invoices_affected.filter(
            (v: unknown): v is string => typeof v === "string"
          )
        : [];

      let targetAppId: string | null = null;

      if (creditPaymentIds.length > 0 && invoiceIds.length > 0) {
        const { rows: apps } = await client.query<{ id: string }>(
          `SELECT id FROM payment_application
            WHERE payment_id = ANY($1::text[])
              AND invoice_id = ANY($2::text[])
              AND voided_at IS NULL
              AND deleted_at IS NULL`,
          [creditPaymentIds, invoiceIds]
        );
        if (apps.length === 1) {
          targetAppId = apps[0].id;
        } else if (apps.length > 1) {
          console.log(
            `   ⏭️  SKIPPED — ${apps.length} candidate applications, ambiguous. Resolve by hand.`
          );
          skipped++;
          continue;
        }
      }

      if (!targetAppId) {
        console.log(
          "   ⏭️  SKIPPED — could not resolve the target payment_application from metadata. Resolve by hand."
        );
        skipped++;
        continue;
      }

      const { rows: pipeRows } = await client.query<{
        id: string;
        status: string;
      }>(
        `SELECT id, status FROM qb_order_pipeline
          WHERE reference_id = $1 AND step = 'payment' AND status = ANY($2::text[])`,
        [anchor.payment_id, NON_TERMINAL]
      );

      console.log(`   metadata → payment_application ${targetAppId}`);
      console.log(
        `   pipeline rows to skip: ${pipeRows.length > 0 ? pipeRows.map((r) => `${r.id}(${r.status})`).join(", ") : "none"}`
      );
      console.log("   soft-delete the $0 payment");

      if (!APPLY) {
        remediated++;
        continue;
      }

      await client.query("BEGIN");
      try {
        // 1. Metadata → the application. COALESCE guard: never overwrite.
        await client.query(
          `UPDATE payment_application
              SET metadata   = $2::jsonb,
                  updated_at = NOW()
            WHERE id = $1 AND metadata IS NULL`,
          [targetAppId, JSON.stringify(md)]
        );

        // 2. Break the retry loop.
        await client.query(
          `UPDATE qb_order_pipeline
              SET status        = 'skipped',
                  error         = $2,
                  next_retry_at = NULL,
                  updated_at    = NOW()
            WHERE reference_id = $1
              AND step = 'payment'
              AND status = ANY($3::text[])`,
          [anchor.payment_id, SKIP_REASON, NON_TERMINAL]
        );

        // 3. Retire the anchor.
        await client.query(
          `UPDATE customer_payment
              SET deleted_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1 AND deleted_at IS NULL`,
          [anchor.payment_id]
        );

        await client.query("COMMIT");
        console.log("   ✅ remediated");
        remediated++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.log(
          `   ❌ ROLLED BACK — ${err instanceof Error ? err.message : String(err)}`
        );
        skipped++;
      }
    }

    console.log(
      `\n${APPLY ? "Applied" : "Would remediate"}: ${remediated} · Skipped: ${skipped}`
    );
    if (!APPLY && remediated > 0) {
      console.log("Re-run with --apply to commit.");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
