/**
 * dump-qb-tax-items.ts
 *
 * Queries the QuickBooks Desktop bridge for all SalesTaxItems and prints
 * { Name, ListID, TaxRate, IsActive } for each. Used to obtain the two
 * canonical ListIDs ("Sale Tax 7%" and "Exempt") that will be persisted on
 * documents as the source of truth for tax in the unified QB pipeline.
 *
 * Run from the backend/ directory:
 *   npx ts-node src/scripts/diagnostics/dump-qb-tax-items.ts
 *
 * Reads QB_BRIDGE_URL and QB_API_KEY (or QB_BRIDGE_API_KEY) from .env.
 * No DB writes. Read-only against QB.
 */

import { bridgeFetch } from "../../lib/quickbooks/bridge-fetch";

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_ATTEMPTS = 60; // 60s ceiling

const QBXML = [
  `<?xml version="1.0" encoding="utf-8"?>`,
  `<?qbxml version="10.0"?>`,
  `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
  `<ItemSalesTaxQueryRq requestID="1">`,
  `<ActiveStatus>All</ActiveStatus>`,
  `</ItemSalesTaxQueryRq>`,
  `</QBXMLMsgsRq></QBXML>`,
].join("");

interface EnqueueResp {
  operationId?: string;
  operation_id?: string;
}

interface StatusResp {
  operation?: {
    status?: "queued" | "processing" | "completed" | "failed";
    result?: Record<string, unknown>;
    error?: string;
  };
}

interface SalesTaxItemRet {
  ListID?: string;
  Name?: string;
  IsActive?: string;
  TaxRate?: string;
  TaxVendorRef?: { ListID?: string; FullName?: string };
}

async function enqueueDirectQuery(qbxml: string): Promise<string> {
  const res = await bridgeFetch<EnqueueResp>("/api/sync/direct-query", {
    method: "POST",
    body: { qbxml },
  });
  const operationId = res.operationId ?? res.operation_id;
  if (!operationId) {
    throw new Error("Bridge did not return operationId from direct-query");
  }
  return operationId;
}

async function pollUntilDone(
  operationId: string
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await bridgeFetch<StatusResp>(
      `/api/sync/status/${operationId}`
    );
    const op = status.operation;
    if (!op) continue;
    if (op.status === "completed") {
      if (!op.result) throw new Error("Bridge returned completed but no result");
      return op.result;
    }
    if (op.status === "failed") {
      throw new Error(`Bridge op failed: ${op.error ?? "unknown error"}`);
    }
    process.stdout.write(`.`);
  }
  throw new Error(`Bridge op ${operationId} did not complete within timeout`);
}

function extractRet(result: Record<string, unknown>): SalesTaxItemRet[] {
  const root: Record<string, unknown> =
    (result as any)?.QBXML?.QBXMLMsgsRs ??
    (result as any)?.QBXMLMsgsRs ??
    result;

  const rs = (root as any)?.ItemSalesTaxQueryRs ?? root;
  const ret = (rs as any)?.ItemSalesTaxRet;
  if (!ret) return [];
  return Array.isArray(ret) ? ret : [ret];
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  console.log(`[dump-qb-tax-items] Submitting ItemSalesTaxQueryRq to bridge...`);
  const opId = await enqueueDirectQuery(QBXML);
  console.log(`[dump-qb-tax-items] operationId=${opId}, polling`);

  const result = await pollUntilDone(opId);
  console.log(`\n[dump-qb-tax-items] Got response, parsing\n`);

  const items = extractRet(result);
  if (items.length === 0) {
    console.log(`[dump-qb-tax-items] No SalesTaxItems returned by QB.`);
    console.log(`Raw result keys:`, Object.keys(result));
    return;
  }

  console.log(
    `${pad("Name", 30)} ${pad("ListID", 26)} ${pad("Rate", 8)} Active`
  );
  console.log("-".repeat(80));
  for (const it of items) {
    const name = it.Name ?? "(no name)";
    const id = it.ListID ?? "(no id)";
    const rate = it.TaxRate ?? "0";
    const active = it.IsActive ?? "?";
    console.log(`${pad(name, 30)} ${pad(id, 26)} ${pad(rate, 8)} ${active}`);
  }

  console.log(
    `\n[dump-qb-tax-items] Found ${items.length} sales tax item(s).`
  );
  console.log(`Set these in backend/.env:`);
  const taxed = items.find(
    (i) => parseFloat(i.TaxRate ?? "0") > 0 && i.IsActive !== "0"
  );
  const exempt = items.find(
    (i) =>
      parseFloat(i.TaxRate ?? "0") === 0 &&
      (i.Name ?? "").toLowerCase().includes("exempt")
  );
  if (taxed) console.log(`  QB_TAX_ITEM_LISTID_TAXED=${taxed.ListID}`);
  if (exempt) console.log(`  QB_TAX_ITEM_LISTID_EXEMPT=${exempt.ListID}`);
  if (!taxed || !exempt) {
    console.log(
      `(could not auto-detect both — pick the right ListIDs from the table above)`
    );
  }
}

main().catch((err) => {
  console.error(`[dump-qb-tax-items] FAILED:`, err);
  process.exit(1);
});
