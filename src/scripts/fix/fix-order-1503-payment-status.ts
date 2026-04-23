/**
 * One-off fix: register Medusa payment capture for order 1503 (order_01KPXB13S2MM8HHYP75QWXF7K2)
 * whose credit_memo apply was processed correctly in pos_invoice but skipped
 * registerMedusaPayment due to wrong method mapping ("credit_memo" → "credit").
 *
 * Run: yarn medusa exec src/scripts/fix/fix-order-1503-payment-status.ts
 */
import { registerMedusaPayment } from "../../api/admin/invoices/register-medusa-payment";

export default async function fixOrder1503({ container }: { container: any }) {
  const ORDER_ID = "order_01KPXB13S2MM8HHYP75QWXF7K2";
  const AMOUNT_CENTS = 2682; // $26.82

  console.log(`[fix-1503] Registering Medusa payment capture for ${ORDER_ID}`);

  const paymentId = await registerMedusaPayment(container, {
    order_id: ORDER_ID,
    amount: AMOUNT_CENTS,
    payment_method: "credit_memo",
    invoice_total: AMOUNT_CENTS,
  });

  if (paymentId) {
    console.log(`[fix-1503] ✅ Captured — Medusa payment.id = ${paymentId}`);
  } else {
    console.log(`[fix-1503] ⚠️  registerMedusaPayment returned null (check logs above)`);
  }
}
