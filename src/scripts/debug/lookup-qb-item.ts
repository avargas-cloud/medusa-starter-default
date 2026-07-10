/**
 * One-off: look up a QB item by name/FullName across ALL item types
 * (Inventory, Service, NonInventory, OtherCharge, ...) via a direct
 * ItemQueryRq — same query the /admin/quickbooks/lookup route uses for
 * docType="Item", just runnable as a script instead of over HTTP.
 *
 * Usage:
 *   QB_ITEM_NAME="SHIPPING-ADJUSTMENT" npx medusa exec ./src/scripts/debug/lookup-qb-item.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../lib/quickbooks/client/core";

const ITEM_RET_KEYS = [
  "ItemServiceRet",
  "ItemInventoryRet",
  "ItemNonInventoryRet",
  "ItemOtherChargeRet",
  "ItemDiscountRet",
  "ItemPaymentRet",
  "ItemSalesTaxRet",
  "ItemGroupRet",
  "ItemInventoryAssemblyRet",
  "ItemFixedAssetRet",
];

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

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
    if (op.status === "failed") {
      throw new Error(`QB query failed: ${op.error || "Unknown error"}`);
    }
  }
  throw new Error("QB query timed out");
}

export default async function lookupQbItem({ container }: ExecArgs) {
  void container;
  const name = (process.env.QB_ITEM_NAME || "").trim();
  if (!name) {
    console.error("QB_ITEM_NAME env var is required");
    return;
  }

  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<ItemQueryRq requestID="1">`,
    `<FullName>${escapeXml(name)}</FullName>`,
    `</ItemQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  console.log(`Looking up QB item "${name}"...`);
  const rawResult = await runDirectQuery(qbxml);
  const qbMsgs: Record<string, unknown> =
    (rawResult as any)?.QBXML?.QBXMLMsgsRs ?? (rawResult as any)?.QBXMLMsgsRs ?? rawResult;
  const itemQueryRs: Record<string, unknown> | undefined =
    (qbMsgs as any)?.ItemQueryRs ?? (rawResult as any)?.ItemQueryRs;

  if (!itemQueryRs) {
    console.log(`❌ Item "${name}" not found in QuickBooks (empty ItemQueryRs).`);
    console.log("Raw result:", JSON.stringify(rawResult).slice(0, 1000));
    return;
  }

  let found = false;
  for (const retKey of ITEM_RET_KEYS) {
    const raw = (itemQueryRs as any)[retKey];
    if (!raw) continue;
    const docs: Record<string, any>[] = Array.isArray(raw) ? raw : [raw];
    const qbItemType = retKey.replace(/^Item/, "").replace(/Ret$/, "");
    for (const d of docs) {
      found = true;
      console.log("✅ Found:");
      console.log(`   Name/FullName: ${d.FullName || d.Name}`);
      console.log(`   ListID:        ${d.ListID}`);
      console.log(`   EditSequence:  ${d.EditSequence}`);
      console.log(`   qbItemType:    ${qbItemType}`);
      console.log(`   IsActive:      ${d.IsActive}`);
      console.log(`   SalesDesc:     ${d.SalesDesc ?? d.SalesAndPurchase?.SalesDesc ?? "(none)"}`);
      console.log(`   SalesPrice:    ${d.SalesPrice ?? d.SalesAndPurchase?.SalesPrice ?? "(none)"}`);
      console.log(`   AccountRef:    ${JSON.stringify(d.AccountRef ?? d.SalesAndPurchase?.IncomeAccountRef)}`);
    }
  }
  if (!found) {
    console.log(`❌ Item "${name}" not found. Raw ItemQueryRs keys: ${Object.keys(itemQueryRs).join(", ")}`);
  }
}
