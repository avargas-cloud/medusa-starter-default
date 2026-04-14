/**
 * test-customer.ts — QB Customer Operations (Remote)
 *
 * Crea un cliente de prueba en QB y lo verifica vía query.
 * Útil para verificar que el bridge puede escribir a QB correctamente.
 *
 * Usage:
 *   cd backend
 *   npx ts-node --project tsconfig.json scripts/qb/test-customer.ts
 */

import { qbRequest, waitForOp } from "./config";

async function main() {
  console.log("\n=== TEST: CUSTOMER OPERATIONS (Remote) ===\n");

  const randomId = Math.floor(Math.random() * 9000) + 1000;
  const testName = `Test Remote ${randomId}`;

  // ─── STEP 1: Create Customer ──────────────────────────────────────────────
  console.log(`[1/2] Creating Customer: "${testName}"...`);
  const createRes = await qbRequest("POST", "/api/customers", {
    Name: `${testName} #rem${randomId}`,
    FirstName: "Remote",
    LastName: `Test${randomId}`,
    CompanyName: `${testName} Inc.`,
    Email: `test${randomId}@ecopowertech.com`,
    Phone: "786-555-0000",
    BillAddress: {
      Addr1: "2760 NW 84th Street",
      City: "Hialeah",
      State: "FL",
      PostalCode: "33016",
    },
  });

  if (!createRes.operationId) {
    throw new Error(
      `Failed to queue customer creation: ${JSON.stringify(createRes)}`
    );
  }

  const createOp = await waitForOp(createRes.operationId, "Customer Creation");
  const custRet = (
    createOp.result?.QBXML?.QBXMLMsgsRs ?? createOp.result?.QBXMLMsgsRs
  )?.CustomerAddRs?.CustomerRet;

  const listId = custRet?.ListID ?? createOp.txnId;
  console.log(`   ✅ Customer Created!`);
  console.log(`   ListID:    ${listId}`);
  console.log(`   Name:      ${custRet?.Name ?? testName}`);

  // ─── STEP 2: Query to verify ──────────────────────────────────────────────
  if (listId) {
    console.log(`\n[2/2] Querying customer to verify...`);
    const readRes = await qbRequest("GET", `/api/customers?ListID=${listId}`);

    if (readRes.operationId) {
      const readOp = await waitForOp(readRes.operationId, "Customer Query");
      const readRet = (
        readOp.result?.QBXML?.QBXMLMsgsRs ?? readOp.result?.QBXMLMsgsRs
      )?.CustomerQueryRs?.CustomerRet;
      console.log(
        `   ✅ Verified! Name: ${readRet?.Name}, Balance: ${readRet?.Balance ?? "0.00"}`
      );
    }
  }

  console.log("\n✅ Customer test complete!");
}

main().catch((e) => {
  console.error("\n❌ TEST FAILED:", e.message);
  process.exit(1);
});
