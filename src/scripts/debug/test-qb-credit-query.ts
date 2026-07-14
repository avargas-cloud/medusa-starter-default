import {
  buildCreditMemoQuery,
  buildReceivePaymentQuery,
  parseCreditMemos,
  parsePayments,
  runDirectQuery,
} from "../../api/admin/quickbooks/customer-credits/_lib/qb-credit-query";

/**
 * Validates the customer-credits QBXML against the live QB bridge.
 * Usage: medusa exec ./src/scripts/debug/test-qb-credit-query.ts
 * (edit LIST_ID below to a customer's qb_list_id)
 */
export default async function testQbCreditQuery(): Promise<void> {
  const LIST_ID = process.env.QB_TEST_LIST_ID || "80001F81-1721061377"; // NZ DESIGN

  console.log(`\n=== CreditMemoQueryRq for ListID ${LIST_ID} ===`);
  try {
    const cmRaw = await runDirectQuery(buildCreditMemoQuery({ listId: LIST_ID }));
    const cms = parseCreditMemos(cmRaw);
    console.log(`parsed credit memos with remaining>0: ${cms.length}`);
    console.log(JSON.stringify(cms, null, 2));
    // Peek raw structure to confirm field names
    const rawKeys = JSON.stringify(cmRaw).slice(0, 600);
    console.log(`raw (first 600 chars): ${rawKeys}`);
  } catch (e) {
    console.error("CreditMemo query failed:", e instanceof Error ? e.message : e);
  }

  console.log(`\n=== ReceivePaymentQueryRq for ListID ${LIST_ID} ===`);
  try {
    const payRaw = await runDirectQuery(
      buildReceivePaymentQuery({ listId: LIST_ID })
    );
    const pays = parsePayments(payRaw);
    console.log(`parsed unapplied payments with remaining>0: ${pays.length}`);
    console.log(JSON.stringify(pays, null, 2));
  } catch (e) {
    console.error("Payment query failed:", e instanceof Error ? e.message : e);
  }
}
