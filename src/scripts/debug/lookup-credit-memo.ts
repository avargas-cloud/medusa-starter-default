import { bridgeFetch, POLL_INTERVAL_MS, MAX_POLL_ATTEMPTS } from "../../lib/quickbooks/client/core";

async function runDirectQuery(qbxml: string): Promise<Record<string, unknown>> {
  const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", { qbxml });
  const operationId: string = enqueueRes?.operationId || enqueueRes?.operation_id;
  if (!operationId) throw new Error("Bridge did not return operationId");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await bridgeFetch("GET", `/api/sync/status/${operationId}`);
    const op = statusRes?.operation;
    if (!op) continue;
    if (op.status === "completed") return op.result as Record<string, unknown>;
    if (op.status === "failed") throw new Error(op.error || "QB operation failed");
  }
  throw new Error("Timed out waiting for QB direct query");
}

async function main() {
  const refNumber = process.argv[2];
  if (!refNumber) {
    console.error("Usage: tsx lookup-credit-memo.ts <RefNumber>");
    process.exit(1);
  }

  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<CreditMemoQueryRq requestID="1">`,
    `<RefNumber>${refNumber}</RefNumber>`,
    `<IncludeLineItems>true</IncludeLineItems>`,
    `<IncludeLinkedTxns>true</IncludeLinkedTxns>`,
    `</CreditMemoQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  const rawResult = await runDirectQuery(qbxml);
  const qbMsgs: any = (rawResult as any)?.QBXML?.QBXMLMsgsRs ?? (rawResult as any)?.QBXMLMsgsRs ?? rawResult;
  const retRaw = qbMsgs?.CreditMemoQueryRs?.CreditMemoRet;
  console.log(JSON.stringify(retRaw, null, 2));
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
