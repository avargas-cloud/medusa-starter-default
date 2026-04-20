/**
 * Bulk-fetches active QB items (with metadata) from the bridge.
 *
 * Uses the same proven path as check-qb-active-products.ts:
 *   GET /api/products/active-with-description → poll /api/sync/status/{opId}
 *
 * Returns QbItemRaw[] normalized across ItemInventoryRet / ItemServiceRet /
 * ItemNonInventoryRet variants. Each ret type carries the same fields we
 * requested in the QBXML builder (see item.ts buildItemQueryActiveWithDesc).
 */
import type { QbItemRaw, QbItemType, QbRef } from "../../../lib/quickbooks/bulk-item-types";

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com";
const API_KEY = process.env.QB_API_KEY || "";
const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 20;

type BridgeOp = {
  status: "pending" | "processing" | "completed" | "failed" | string;
  error?: string;
  message?: string;
  qbxmlResponse?: string;
  result?: {
    QBXML?: { QBXMLMsgsRs?: { ItemQueryRs?: Record<string, unknown> } };
    ItemQueryRs?: Record<string, unknown>;
  };
};

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || ![502, 503, 504].includes(res.status)) return res;
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 8_000));
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 8_000));
    }
  }
  throw new Error("All retries exhausted");
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function refOrUndefined(raw: unknown): QbRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const listId = typeof obj.ListID === "string" ? obj.ListID : undefined;
  const fullName = typeof obj.FullName === "string" ? obj.FullName : undefined;
  if (listId === undefined && fullName === undefined) return undefined;
  return { ListID: listId, FullName: fullName };
}

function toItemRaw(item: Record<string, unknown>, itemType: QbItemType): QbItemRaw | null {
  const listId = typeof item.ListID === "string" ? item.ListID : null;
  if (!listId) return null;
  const str = (k: string): string | undefined => (typeof item[k] === "string" ? (item[k] as string) : undefined);
  const num = (k: string): string | number | undefined => {
    const v = item[k];
    return typeof v === "string" || typeof v === "number" ? v : undefined;
  };
  return {
    ListID: listId,
    EditSequence: str("EditSequence"),
    Name: str("Name"),
    FullName: str("FullName"),
    IsActive: str("IsActive") ?? (typeof item.IsActive === "boolean" ? (item.IsActive as boolean) : undefined),
    ManufacturerPartNumber: str("ManufacturerPartNumber"),
    SalesDesc: str("SalesDesc"),
    PurchaseDesc: str("PurchaseDesc"),
    SalesPrice: num("SalesPrice"),
    PurchaseCost: num("PurchaseCost"),
    AverageCost: num("AverageCost"),
    IncomeAccountRef: refOrUndefined(item.IncomeAccountRef),
    COGSAccountRef: refOrUndefined(item.COGSAccountRef),
    PrefVendorRef: refOrUndefined(item.PrefVendorRef),
    itemType,
  };
}

function parseItemQueryRs(queryRs: Record<string, unknown>): QbItemRaw[] {
  const inventory = asArray(queryRs.ItemInventoryRet as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const service = asArray(queryRs.ItemServiceRet as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const nonInventory = asArray(queryRs.ItemNonInventoryRet as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const out: QbItemRaw[] = [];
  for (const i of inventory) {
    const raw = toItemRaw(i, "Inventory");
    if (raw) out.push(raw);
  }
  for (const i of service) {
    const raw = toItemRaw(i, "Service");
    if (raw) out.push(raw);
  }
  for (const i of nonInventory) {
    const raw = toItemRaw(i, "NonInventory");
    if (raw) out.push(raw);
  }
  return out;
}

export type FetchResult = {
  items: QbItemRaw[];
  operationId: string;
  totalFetched: number;
};

export async function fetchQbBulkItems(opts: { logger?: (msg: string) => void } = {}): Promise<FetchResult> {
  const log = opts.logger ?? ((msg: string) => console.log(msg));
  if (!API_KEY) {
    throw new Error("QB_API_KEY environment variable is not set");
  }
  log(`[mass-sync] Bridge: ${BRIDGE_URL} — requesting active items with metadata`);

  const initRes = await fetchWithRetry(`${BRIDGE_URL}/api/products/active-with-description`, {
    headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
  });
  if (!initRes.ok) {
    const body = await initRes.text().catch(() => "");
    throw new Error(`Bridge init failed ${initRes.status}: ${body.slice(0, 300)}`);
  }
  const initJson = (await initRes.json()) as { operationId?: string };
  const operationId = initJson.operationId;
  if (!operationId) throw new Error("Bridge did not return operationId");
  log(`[mass-sync] operationId=${operationId}; polling every 30s (up to 10 min)`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
      headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
    });
    if (!statusRes.ok) {
      log(`[mass-sync]  poll ${attempt}/${MAX_POLL_ATTEMPTS} status=${statusRes.status}`);
      continue;
    }
    const body = (await statusRes.json()) as { success?: boolean; operation?: BridgeOp };
    const op = body.operation;
    if (!op) continue;
    if (op.status === "failed") {
      throw new Error(`Bridge op failed: ${op.error ?? op.message ?? "unknown"}`);
    }
    if (op.status === "completed") {
      const queryRs = op.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs ?? op.result?.ItemQueryRs;
      if (!queryRs) {
        throw new Error("Bridge returned completed op but no ItemQueryRs");
      }
      const items = parseItemQueryRs(queryRs);
      log(`[mass-sync] parsed ${items.length} items from bridge response`);
      return { items, operationId, totalFetched: items.length };
    }
    log(`[mass-sync]  poll ${attempt}/${MAX_POLL_ATTEMPTS} status=${op.status}`);
  }
  throw new Error(`Bridge polling timed out after ${MAX_POLL_ATTEMPTS} attempts`);
}
