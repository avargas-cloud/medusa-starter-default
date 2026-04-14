/**
 * test-sales-order.ts — Sales Order Creation (Remote)
 *
 * Crea un Sales Order standalone en QB usando ListIDs reales.
 * Ajusta CUSTOMER_LISTID y PRODUCT_LISTID con valores reales de tu QB.
 *
 * Usage:
 *   cd backend
 *   npx ts-node --project tsconfig.json scripts/qb/test-sales-order.ts
 */

import {
  qbRequest,
  waitForOp,
  DEFAULT_CUSTOMER_LISTID,
  DEFAULT_PRODUCT_LISTID,
  DEFAULT_SITE_LISTID,
} from "./config";

// ── Override these for your specific test ────────────────────────────────────
const CUSTOMER_LISTID = process.env.QB_TEST_CUSTOMER ?? DEFAULT_CUSTOMER_LISTID;
const PRODUCT_LISTID = process.env.QB_TEST_PRODUCT ?? DEFAULT_PRODUCT_LISTID;
const SITE_LISTID = process.env.QB_TEST_SITE ?? DEFAULT_SITE_LISTID;

async function main() {
  console.log("\n=== TEST: SALES ORDER CREATION (Remote) ===");
  console.log(`   Customer: ${CUSTOMER_LISTID}`);
  console.log(`   Product:  ${PRODUCT_LISTID}\n`);

  const soRes = await qbRequest("POST", "/api/sales-orders", {
    customerId: CUSTOMER_LISTID,
    date: new Date().toISOString().split("T")[0],
    salesTaxCode: "Sale Tax 7%",
    memo: `Remote Test SO ${new Date().toLocaleTimeString()}`,
    items: [
      {
        productId: PRODUCT_LISTID,
        quantity: 1,
        price: 49.99,
        desc: "Remote test — Sales Order",
        siteId: SITE_LISTID,
      },
    ],
  });

  if (!soRes.operationId) {
    throw new Error(`Failed to queue Sales Order: ${JSON.stringify(soRes)}`);
  }

  console.log(`   OperationID: ${soRes.operationId}`);
  const op = await waitForOp(soRes.operationId, "Sales Order Creation");

  const soRet = (op.result?.QBXML?.QBXMLMsgsRs ?? op.result?.QBXMLMsgsRs)
    ?.SalesOrderAddRs?.SalesOrderRet;

  console.log("\n✅ Sales Order Created!");
  console.log(`   TxnID:     ${op.txnId ?? soRet?.TxnID}`);
  console.log(`   RefNumber: ${op.refNumber ?? soRet?.RefNumber}`);
  console.log("\n   💾 Save these values to use in test-invoice.ts");
}

main().catch((e) => {
  console.error("\n❌ TEST FAILED:", e.message);
  process.exit(1);
});
