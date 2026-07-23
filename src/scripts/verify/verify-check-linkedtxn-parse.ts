/**
 * verify-check-linkedtxn-parse.ts — fixtures for extractCheckLinkedTxns().
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-check-linkedtxn-parse.ts
 */
import { extractCheckLinkedTxns } from "../../lib/quickbooks/client/checks";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

// 1. Check with a linked ReceivePayment + CreditMemo (xml2js array shape)
const withRp = {
  TxnID: "CHK-1",
  EditSequence: "111",
  LinkedTxn: [
    { TxnID: "CM-9", TxnType: "CreditMemo", LinkType: "AMTTYPE" },
    { TxnID: "RP-7", TxnType: "ReceivePayment", LinkType: "AMTTYPE" },
  ],
};
const r1 = extractCheckLinkedTxns(withRp);
check("array shape parses", r1 !== null && r1.length === 2);
check(
  "ReceivePayment resolvable",
  !!r1?.find((l) => l.txnType === "ReceivePayment" && l.txnId === "RP-7")
);

// 2. Single LinkedTxn (xml2js explicitArray:false collapses one element to an object)
const single = {
  TxnID: "CHK-2",
  LinkedTxn: { TxnID: "CM-1", TxnType: "CreditMemo" },
};
const r2 = extractCheckLinkedTxns(single);
check("single-object shape parses", r2 !== null && r2.length === 1);
check(
  "no ReceivePayment among links → no-doc case",
  !r2?.find((l) => l.txnType === "ReceivePayment")
);

// 3. No LinkedTxn key at all → capability missing (old bridge) → null
const noKey = { TxnID: "CHK-3", EditSequence: "333" };
check("missing LinkedTxn key → null (capability)", extractCheckLinkedTxns(noKey) === null);

// 4. CheckRet delivered as array (multi-match query)
const asArray = [{ TxnID: "CHK-4", LinkedTxn: { TxnID: "RP-1", TxnType: "ReceivePayment" } }];
const r4 = extractCheckLinkedTxns(asArray);
check("CheckRet-as-array unwraps first", r4?.[0]?.txnId === "RP-1");

console.log(`\nRESULT: ${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
