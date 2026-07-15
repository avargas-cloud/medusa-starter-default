import type { MedusaContainer } from "@medusajs/framework/types";
import { bridgeFetch, pollRawOperationResult } from "../../lib/quickbooks/client/core";

const TXN_ID = "1C9615-1783520981";

export default async function dumpInvoiceRaw({
  container: _container,
}: {
  container: MedusaContainer;
}) {
  const queryResp = await bridgeFetch("GET", `/api/invoices/${TXN_ID}`);
  const queryOpId = queryResp?.operationId;
  if (!queryOpId) throw new Error("Bridge did not return operationId");
  const rawResult = await pollRawOperationResult(queryOpId, console.log);
  console.log("RAW RESULT:");
  console.log(JSON.stringify(rawResult, null, 2));
}
