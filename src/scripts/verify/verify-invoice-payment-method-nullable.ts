/**
 * Verify that pos_invoice.payment_method is nullable end-to-end.
 *
 *   1. Create a pos_invoice with payment_method = null   (skip-payment flow)
 *   2. Read it back and assert null persisted
 *   3. Update it with a real method                       (capture-payment backfill)
 *   4. Read it back and assert the new method persisted
 *   5. Clean up
 *
 * Run with: ./node_modules/.bin/medusa exec ./src/scripts/verify/verify-invoice-payment-method-nullable.ts
 */
import { ExecArgs } from "@medusajs/framework/types";
import { INVOICE_MODULE } from "../../modules/invoices";

export default async function verifyInvoicePaymentMethodNullable({
  container,
}: ExecArgs) {
  const invoiceService: any = container.resolve(INVOICE_MODULE);

  const fakeOrderId = `test_order_${Date.now()}`;
  const fakeCustomerId = `test_cus_${Date.now()}`;

  // Step 1: create with NULL payment_method
  const created = await invoiceService.createPosInvoices({
    invoice_number: 999000 + Math.floor(Math.random() * 999),
    order_id: fakeOrderId,
    customer_id: fakeCustomerId,
    status: "issued",
    subtotal: 10000,
    discount: 0,
    shipping: 0,
    tax: 0,
    untaxed_total: 10000,
    total: 10000,
    amount_paid: 0,
    balance_due: 10000,
    payment_method: null,
    card_brand: null,
    issued_at: new Date(),
    paid_at: null,
    notes: "verify-script: skip-payment scenario",
    created_by: "verify-script",
    shipping_address: null,
    metadata: {},
  });

  console.log(
    `[verify] Step 1 — created invoice ${created.id} with payment_method=${created.payment_method}`
  );
  if (created.payment_method !== null) {
    throw new Error(
      `Expected payment_method=null after create, got ${created.payment_method}`
    );
  }

  // Step 2: read back
  const fetched = await invoiceService.retrievePosInvoice(created.id);
  console.log(
    `[verify] Step 2 — fetched payment_method=${fetched.payment_method}`
  );
  if (fetched.payment_method !== null) {
    throw new Error(
      `Expected payment_method=null after fetch, got ${fetched.payment_method}`
    );
  }

  // Step 3: backfill via update (mirrors the apply-payment route's behaviour)
  await invoiceService.updatePosInvoices({
    id: created.id,
    payment_method: "check",
    card_brand: null,
    amount_paid: 10000,
    balance_due: 0,
    status: "paid",
  });

  // Step 4: read back the backfilled value
  const updated = await invoiceService.retrievePosInvoice(created.id);
  console.log(
    `[verify] Step 4 — after backfill payment_method=${updated.payment_method}`
  );
  if (updated.payment_method !== "check") {
    throw new Error(
      `Expected payment_method=check after backfill, got ${updated.payment_method}`
    );
  }

  // Cleanup
  await invoiceService.deletePosInvoices(created.id);
  console.log(
    `[verify] OK — payment_method nullable + backfill works (cleanup done)`
  );
}
