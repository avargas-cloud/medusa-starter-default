/**
 * Corrects Medusa native Payment Module totals for order 1350.
 *
 * Bug context:
 * A second POS invoice was paid entirely by applying existing customer credit,
 * but the apply path also registered a new native Medusa payment for $3,384.83.
 * POS/finance ledgers are correct; Medusa payment_collection.captured_amount is
 * inflated to $9,803.90.
 *
 * Dry-run:
 *   yarn medusa exec ./src/scripts/fix/fix-order-1350-medusa-paid-amount.ts
 *
 * Apply:
 *   APPLY=1 yarn medusa exec ./src/scripts/fix/fix-order-1350-medusa-paid-amount.ts
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { getDbPool } from "../../api/utils/db-pool";

const ORDER_DISPLAY_ID = 1350;
const PHANTOM_AMOUNT_DOLLARS = 3384.83;

type PaymentRow = {
  id: string;
  amount: string | number;
  captured_at: Date | string | null;
  canceled_at: Date | string | null;
  deleted_at: Date | string | null;
};

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

function toCents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

function rawAmountJson(dollars: string) {
  return { value: dollars, precision: 20 };
}

export default async function fixOrder1350MedusaPaidAmount({
  container,
}: {
  container: MedusaContainer;
}) {
  const APPLY = process.env.APPLY === "1";
  const banner = APPLY ? "APPLY MODE" : "DRY-RUN MODE";

  console.log(`\n${banner} — fix Medusa paid amount for order ${ORDER_DISPLAY_ID}\n`);

  const pool = getDbPool();
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  const { rows: orderRows } = await pool.query(
    `SELECT id, display_id, metadata
       FROM "order"
      WHERE display_id = $1
        AND deleted_at IS NULL`,
    [ORDER_DISPLAY_ID]
  );
  const order = orderRows[0];
  if (!order) {
    throw new Error(`Order display_id=${ORDER_DISPLAY_ID} not found`);
  }

  const { rows: invoiceRows } = await pool.query(
    `SELECT id, invoice_number, total, amount_paid, balance_due, payment_method, status
       FROM pos_invoice
      WHERE order_id = $1
        AND status <> 'voided'
        AND deleted_at IS NULL
      ORDER BY created_at`,
    [order.id]
  );

  const expectedCapturedCents = invoiceRows.reduce(
    (sum: number, row: { amount_paid: string | number }) =>
      sum + Number(row.amount_paid),
    0
  );
  const expectedCapturedDollars = centsToDollars(expectedCapturedCents);

  const { rows: collectionRows } = await pool.query(
    `SELECT pc.id, pc.amount, pc.authorized_amount, pc.captured_amount,
            pc.refunded_amount, pc.status
       FROM order_payment_collection opc
       JOIN payment_collection pc ON pc.id = opc.payment_collection_id
      WHERE opc.order_id = $1
        AND pc.deleted_at IS NULL`,
    [order.id]
  );
  const collection = collectionRows[0];
  if (!collection) {
    throw new Error(`No active payment_collection found for order ${order.id}`);
  }

  const { rows: paymentRows } = await pool.query(
    `SELECT id, amount, captured_at, canceled_at, deleted_at
       FROM payment
      WHERE payment_collection_id = $1
      ORDER BY created_at`,
    [collection.id]
  );
  const activeCapturedPayments = (paymentRows as PaymentRow[]).filter(
    (payment) =>
      payment.captured_at && !payment.canceled_at && !payment.deleted_at
  );

  const phantomAmountCents = Math.round(PHANTOM_AMOUNT_DOLLARS * 100);
  const phantomPayments = activeCapturedPayments.filter(
    (payment) => toCents(payment.amount) === phantomAmountCents
  );
  const activeCapturedCents = activeCapturedPayments.reduce(
    (sum, payment) => sum + toCents(payment.amount),
    0
  );

  console.log(`Order id: ${order.id}`);
  console.log(`POS invoices:`);
  for (const invoice of invoiceRows) {
    console.log(
      `  INV-${invoice.invoice_number}: total=$${centsToDollars(
        Number(invoice.total)
      )}, paid=$${centsToDollars(Number(invoice.amount_paid))}, method=${
        invoice.payment_method ?? "NULL"
      }, status=${invoice.status}`
    );
  }
  console.log(`Expected native captured amount from POS invoices: $${expectedCapturedDollars}`);
  console.log(
    `Current payment_collection ${collection.id}: amount=$${collection.amount}, authorized=$${collection.authorized_amount}, captured=$${collection.captured_amount}, status=${collection.status}`
  );
  console.log(
    `Active native captured payments: $${centsToDollars(activeCapturedCents)} across ${activeCapturedPayments.length} row(s)`
  );
  for (const payment of activeCapturedPayments) {
    const marker = phantomPayments.some((p) => p.id === payment.id)
      ? "PHANTOM"
      : "keep";
    console.log(`  ${marker}: ${payment.id} amount=$${Number(payment.amount).toFixed(2)}`);
  }

  if (expectedCapturedCents !== 641907) {
    throw new Error(
      `Safety check failed: expected POS paid cents should be 641907, got ${expectedCapturedCents}`
    );
  }
  if (phantomPayments.length !== 1) {
    throw new Error(
      `Safety check failed: expected exactly one $${PHANTOM_AMOUNT_DOLLARS.toFixed(
        2
      )} active native payment, found ${phantomPayments.length}`
    );
  }
  if (toCents(collection.captured_amount) === expectedCapturedCents) {
    console.log("\nNo correction needed: payment_collection captured amount already matches POS invoices.");
    return;
  }

  const metadata = (order.metadata ?? {}) as Record<string, unknown>;
  const falseCaptureKeys = Object.entries(metadata)
    .filter(([key, value]) => {
      if (!key.startsWith("payment_capture_")) return false;
      return String(value).includes("$3384.83 captured via Terminal");
    })
    .map(([key]) => key);

  console.log(`False order metadata capture keys to remove: ${falseCaptureKeys.join(", ") || "(none)"}`);

  if (!APPLY) {
    console.log("\nDRY-RUN complete. Re-run with APPLY=1 to apply this correction.");
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const phantom of phantomPayments) {
      await client.query(
        `UPDATE payment
            SET canceled_at = COALESCE(canceled_at, NOW()),
                deleted_at = COALESCE(deleted_at, NOW()),
                metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [
          phantom.id,
          JSON.stringify({
            correction: "order_1350_credit_application_duplicate_native_capture",
            corrected_at: new Date().toISOString(),
            reason:
              "Payment was created by applying existing credit to the second POS invoice; no new money was captured.",
          }),
        ]
      );
      console.log(`Marked phantom native payment ${phantom.id} as canceled/deleted.`);
    }

    await client.query(
      `UPDATE payment_collection
          SET amount = $2,
              raw_amount = $3::jsonb,
              authorized_amount = $2,
              raw_authorized_amount = $3::jsonb,
              captured_amount = $2,
              raw_captured_amount = $3::jsonb,
              status = 'completed',
              completed_at = COALESCE(completed_at, NOW()),
              updated_at = NOW()
        WHERE id = $1`,
      [
        collection.id,
        expectedCapturedDollars,
        JSON.stringify(rawAmountJson(expectedCapturedDollars)),
      ]
    );
    console.log(`Recalculated payment_collection ${collection.id} to $${expectedCapturedDollars}.`);

    for (const invoice of invoiceRows) {
      await client.query(
        `UPDATE pos_invoice
            SET payment_method = 'credit',
                updated_at = NOW()
          WHERE id = $1
            AND payment_method IS DISTINCT FROM 'credit'
            AND EXISTS (
              SELECT 1
                FROM invoice_payment ip
               WHERE ip.invoice_id = pos_invoice.id
                 AND ip.payment_method = 'credit'
            )`,
        [invoice.id]
      );
    }
    console.log("Normalized credit-paid POS invoice payment_method values.");

    if (falseCaptureKeys.length > 0) {
      let removeExpr = "metadata";
      const params: unknown[] = [order.id];
      falseCaptureKeys.forEach((key, idx) => {
        params.push(key);
        removeExpr = `${removeExpr} - $${idx + 2}::text`;
      });
      await client.query(
        `UPDATE "order"
            SET metadata = ${removeExpr},
                updated_at = NOW()
          WHERE id = $1`,
        params
      );
      console.log(`Removed ${falseCaptureKeys.length} false payment_capture metadata key(s).`);
    }

    await client.query("COMMIT");
    console.log("\nCorrection committed.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const {
    data: [updatedOrder],
  } = await query.graph({
    entity: "order",
    fields: [
      "id",
      "display_id",
      "payment_collections.amount",
      "payment_collections.authorized_amount",
      "payment_collections.captured_amount",
      "payment_collections.status",
    ],
    filters: { id: order.id },
  });
  console.log(`\nVerification: ${JSON.stringify(updatedOrder, null, 2)}`);
}
