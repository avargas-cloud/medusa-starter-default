/**
 * config.ts — QB Bridge Remote Connection Config
 *
 * Reads from environment variables (backend/.env).
 * All scripts import from here — change the URL once, affects all scripts.
 *
 * Usage: set QB_BRIDGE_URL and QB_API_KEY in backend/.env
 */

import * as dotenv from "dotenv";
import * as path from "path";

// Load backend/.env
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const BRIDGE_URL =
  process.env.QB_BRIDGE_URL || "https://ecopower-qb.loca.lt";
export const API_KEY =
  process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD";

// Default test IDs — update when testing with specific QB entities
// Find these in QB Desktop or via GET /api/customers?ListID=... or /api/products?FullName=...
export const DEFAULT_CUSTOMER_LISTID = "8000004E-1342117388"; // EPT Alejandro Vargas
export const DEFAULT_PRODUCT_LISTID = "800019EA-1715274093"; // EAP-AS1-8S
export const DEFAULT_SITE_LISTID = "80000001-1331053531"; // Principal Warehouse

// ─── Shared fetch helper ────────────────────────────────────────────────────

export async function qbRequest(
  method: string,
  path: string,
  body?: any
): Promise<any> {
  const url = `${BRIDGE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

// ─── Poll until completed/failed ────────────────────────────────────────────

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForOp(
  opId: string,
  label: string,
  intervalMs = 5000
): Promise<any> {
  process.stdout.write(`⏳ Waiting for ${label}`);
  let attempts = 0;
  while (attempts < 60) {
    // max ~5 min
    await sleep(intervalMs);
    const res = await qbRequest("GET", `/api/sync/status/${opId}`);
    const op = res.operation ?? res;

    if (op.status === "completed") {
      console.log(" ✅ DONE");
      return op; // return the full op (has txnId, refNumber, result)
    }
    if (op.status === "failed") {
      throw new Error(`${label} FAILED: ${JSON.stringify(op.error)}`);
    }
    process.stdout.write(".");
    attempts++;
  }
  throw new Error(`${label} timed out after ${attempts} attempts`);
}
