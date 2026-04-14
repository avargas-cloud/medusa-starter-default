/**
 * test-prepayment-flow.ts — Full E-Commerce Order Flow (Remote)
 *
 * Prueba el flujo completo de e-commerce:
 *   1. Crear Sales Order (pedido colocado)
 *   2. Receive Payment como crédito sin aplicar (pago capturado)
 *   3. Crear Invoice vinculado al SO (fulfillment)
 *   4. Aplicar el crédito al Invoice (cierra el loop contable)
 *
 * Ajusta los ListIDs al inicio del script antes de correr.
 *
 * Usage:
 *   cd backend
 *   npx ts-node --project tsconfig.json scripts/qb/test-prepayment-flow.ts
 */

import {
  qbRequest,
  waitForOp,
  DEFAULT_CUSTOMER_LISTID,
  DEFAULT_PRODUCT_LISTID,
  DEFAULT_SITE_LISTID,
} from "./config";

// ── Config ───────────────────────────────────────────────────────────────────
const CUSTOMER_LISTID = process.env.QB_TEST_CUSTOMER ?? DEFAULT_CUSTOMER_LISTID;
const PRODUCT_LISTID = process.env.QB_TEST_PRODUCT ?? DEFAULT_PRODUCT_LISTID;
const SITE_LISTID = process.env.QB_TEST_SITE ?? DEFAULT_SITE_LISTID;
const ORDER_AMOUNT = 49.99;
const TEST_LABEL = `Remote Test ${new Date().toISOString().slice(0, 10)}`;

async function main() {
  console.log("\n=== TEST: FULL PREPAYMENT FLOW (Remote) ===");
  console.log(`   Customer:  ${CUSTOMER_LISTID}`);
  console.log(`   Product:   ${PRODUCT_LISTID}`);
  console.log(`   Amount:    $${ORDER_AMOUNT}\n`);

  // ─── STEP 1: Create Sales Order ───────────────────────────────────────────
  console.log("[1/4] Creating Sales Order...");
  const soRes = await qbRequest("POST", "/api/sales-orders", {
    customerId: CUSTOMER_LISTID,
    date: new Date().toISOString().split("T")[0],
    salesTaxCode: "Sale Tax 7%",
    memo: `Web Order — ${TEST_LABEL}`,
    items: [
      {
        productId: PRODUCT_LISTID,
        quantity: 1,
        price: ORDER_AMOUNT,
        desc: "E-commerce test item",
        siteId: SITE_LISTID,
      },
    ],
  });

  if (!soRes.operationId)
    throw new Error(`SO queue failed: ${JSON.stringify(soRes)}`);
  const soOp = await waitForOp(soRes.operationId, "Sales Order");
  const soTxnId = soOp.txnId;
  const soRefNumber = soOp.refNumber;
  console.log(`   TxnID:     ${soTxnId}`);
  console.log(`   RefNumber: ${soRefNumber}`);

  // ─── STEP 2: Receive Payment (unapplied credit) ───────────────────────────
  console.log("\n[2/4] Receiving Payment (unapplied credit)...");
  const payRes = await qbRequest("POST", "/api/payments", {
    customerId: CUSTOMER_LISTID,
    amount: ORDER_AMOUNT,
    paymentMethod: "Visa",
    refNumber: `PAY-${Date.now().toString().slice(-6)}`,
    memo: `Web Order Payment — ${TEST_LABEL}`,
    autoApply: false, // ← keep as open credit
  });

  if (!payRes.operationId)
    throw new Error(`Payment queue failed: ${JSON.stringify(payRes)}`);
  const payOp = await waitForOp(payRes.operationId, "Receive Payment");
  const payTxnId = payOp.txnId;
  console.log(`   TxnID:     ${payTxnId}`);

  // ─── STEP 3: Create Invoice linked to Sales Order ─────────────────────────
  console.log("\n[3/4] Creating Invoice (linked to Sales Order)...");
  const invRes = await qbRequest("POST", "/api/invoices", {
    customerId: CUSTOMER_LISTID,
    LinkToTxnID: soTxnId,
    soRefNumber: soRefNumber,
    memo: `Shipped — ${TEST_LABEL}`,
  });

  if (!invRes.operationId)
    throw new Error(`Invoice queue failed: ${JSON.stringify(invRes)}`);
  const invOp = await waitForOp(invRes.operationId, "Invoice Creation");
  const invTxnId = invOp.txnId;
  console.log(`   TxnID:     ${invTxnId}`);
  console.log(`   RefNumber: ${invOp.refNumber}`);

  // ─── STEP 4: Apply Payment Credit to Invoice ──────────────────────────────
  if (invTxnId && payTxnId) {
    console.log("\n[4/4] Applying payment credit to Invoice...");
    const applyRes = await qbRequest("POST", "/api/payments", {
      customerId: CUSTOMER_LISTID,
      amount: ORDER_AMOUNT,
      invoiceId: invTxnId,
      creditTxnId: payTxnId,
    });

    if (applyRes.operationId) {
      await waitForOp(applyRes.operationId, "Apply Credit");
      console.log("   ✅ Credit applied — Invoice balance should be $0.00");
    }
  } else {
    console.log(
      "\n[4/4] ⚠️  Skipping apply credit — missing txnId (invoice or payment not yet polled)"
    );
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log("\n=== FLOW SUMMARY ===");
  console.log(`   Sales Order:   ${soTxnId}  (Ref: ${soRefNumber})`);
  console.log(`   Payment:       ${payTxnId}`);
  console.log(`   Invoice:       ${invTxnId}  (Ref: ${invOp?.refNumber})`);
  console.log(
    "\n   ✅ Full prepayment flow complete — check QB Desktop to verify!"
  );
}

main().catch((e) => {
  console.error("\n❌ FLOW FAILED:", e.message);
  process.exit(1);
});
