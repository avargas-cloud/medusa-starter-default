/**
 * backfill-terminal-invoices.ts
 *
 * Backfills orders created via Dejavoo terminal that are missing:
 *   1. customer_payment.status='applied'  (Bug B — was 'available')
 *   2. Medusa native payment capture      (Bug A — registerMedusaPayment not called)
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/fix/backfill-terminal-invoices.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { FINANCE_MODULE } from "../../modules/finance";
import { INVOICE_MODULE } from "../../modules/invoices";
import { registerMedusaPayment } from "../../api/admin/invoices/register-medusa-payment";

// Hardcoded order IDs to backfill — add more here if needed
const ORDER_IDS = [
  "order_01KP6VHY4YN0ME871WZ9TNNBDM", // display_id 1362, IN-20014
  "order_01KP6X364JCGTT54CQM6HY9MAT", // display_id 1363, IN-20015
];

export default async function backfillTerminalInvoices({
  container,
}: {
  container: MedusaContainer;
}) {
  const financeService = container.resolve(FINANCE_MODULE) as any;
  const invoiceService = container.resolve(INVOICE_MODULE) as any;
  const query = container.resolve("query") as any;

  console.log(`\n[backfill-terminal-invoices] Processing ${ORDER_IDS.length} order(s)...\n`);

  for (const orderId of ORDER_IDS) {
    console.log(`──── Order ${orderId} ────`);

    // 1. Load the invoice for this order
    const invoices = await invoiceService.listPosInvoices(
      { order_id: orderId },
      {}
    );
    const invoice = invoices?.[0];
    if (!invoice) {
      console.log(`  SKIP: no PosInvoice found for order ${orderId}`);
      continue;
    }
    console.log(`  Invoice: ${invoice.id} | total=${invoice.total} | amount_paid=${invoice.amount_paid}`);

    // 2. Find the customer_payment linked to this invoice via payment_application
    const applications = await financeService.listPaymentApplications(
      { order_id: orderId },
      {}
    );
    if (!applications?.length) {
      console.log(`  SKIP: no PaymentApplication found for order ${orderId}`);
      continue;
    }
    const app = applications[0];
    console.log(`  PaymentApplication: ${app.id} | payment_id=${app.payment_id}`);

    const cpay = await financeService.retrieveCustomerPayment(app.payment_id);
    if (!cpay) {
      console.log(`  SKIP: could not retrieve CustomerPayment ${app.payment_id}`);
      continue;
    }
    console.log(`  CustomerPayment: ${cpay.id} | display_id=${cpay.display_id} | status=${cpay.status}`);

    // 3. Check if already done
    const {
      data: [order],
    } = await query.graph({
      entity: "order",
      fields: ["id", "payment_collections.id", "payment_collections.status"],
      filters: { id: orderId },
    });
    const pcStatus = order?.payment_collections?.[0]?.status;
    console.log(`  PaymentCollection status: ${pcStatus}`);

    if (cpay.status === "applied" && pcStatus === "completed") {
      console.log(`  OK: already fully backfilled — skipping.\n`);
      continue;
    }

    // 4. Mark cpay as applied (Bug B fix)
    if (cpay.status !== "applied") {
      await financeService.updateCustomerPayments({
        id: cpay.id,
        status: "applied",
      });
      console.log(`  [+] CustomerPayment ${cpay.id} status → 'applied'`);
    } else {
      console.log(`  [=] CustomerPayment already applied — skipping status update`);
    }

    // 5. Register in Medusa native payment module (Bug A fix)
    if (pcStatus !== "completed") {
      const posPaymentMethod =
        (cpay.metadata as any)?.pos_payment_method ?? "card";
      console.log(`  [+] Calling registerMedusaPayment (method=${posPaymentMethod}, amount=${invoice.amount_paid}, total=${invoice.total})`);
      const medusaPaymentId = await registerMedusaPayment(container, {
        order_id: orderId,
        amount: invoice.amount_paid,
        payment_method: posPaymentMethod,
        invoice_total: invoice.total,
      });
      if (medusaPaymentId) {
        await financeService.updateCustomerPayments({
          id: cpay.id,
          medusa_payment_synced: true,
        });
        console.log(`  [+] Medusa payment captured: ${medusaPaymentId} | medusa_payment_synced → true`);
      } else {
        console.log(`  [!] registerMedusaPayment returned null (see logs above for reason)`);
      }
    } else {
      console.log(`  [=] PaymentCollection already completed — skipping Medusa capture`);
    }

    console.log(`  Done.\n`);
  }

  console.log("[backfill-terminal-invoices] Finished.\n");
}
