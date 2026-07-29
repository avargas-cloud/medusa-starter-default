/**
 * Verify that the QB bridge returns TermsRef and VendorTypeRef for a vendor query.
 * Usage: ts-node src/scripts/verify/verify-vendor-terms-fields.ts [ListID]
 *
 * Defaults to 1000Bulbs.com (8000034D-1396987893) which currently has NULL terms in DB.
 * Compares DB snapshot vs live bridge response.
 */

import "dotenv/config";
import { DataSource } from "typeorm";
import { requireBridgeUrl } from "../../lib/quickbooks/bridge-url";

const BRIDGE_URL = requireBridgeUrl();
const API_KEY = process.env.QB_API_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

const LIST_ID = process.argv[2] || "8000034D-1396987893"; // 1000Bulbs.com

async function main() {
  console.log(`\n=== QB Vendor Terms Field Verifier ===`);
  console.log(`Target ListID: ${LIST_ID}`);
  console.log(`Bridge: ${BRIDGE_URL}\n`);

  // 1. Check current DB state
  const ds = new DataSource({
    type: "postgres",
    url: DATABASE_URL,
    synchronize: false,
  });
  await ds.initialize();

  const [row] = await ds.query(
    `SELECT full_name, terms_ref_name, vendor_type_ref_name, last_synced_at
     FROM qb_vendor WHERE qb_list_id = $1`,
    [LIST_ID]
  );
  if (row) {
    console.log("--- DB (current) ---");
    console.log(`  full_name:           ${row.full_name}`);
    console.log(`  terms_ref_name:      ${row.terms_ref_name ?? "(null)"}`);
    console.log(`  vendor_type_ref_name:${row.vendor_type_ref_name ?? "(null)"}`);
    console.log(`  last_synced_at:      ${row.last_synced_at}`);
  } else {
    console.log(`  [!] Vendor with ListID ${LIST_ID} not found in DB`);
  }
  await ds.destroy();

  // 2. Query bridge for live data
  console.log("\n--- QB Bridge (live) ---");
  const bridgeRes = await fetch(`${BRIDGE_URL}/api/vendors`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "bypass-tunnel-reminder": "true",
    },
    body: JSON.stringify({ action: "query", ListID: LIST_ID }),
  });

  if (!bridgeRes.ok) {
    console.error(`  [!] Bridge HTTP ${bridgeRes.status}`);
    const text = await bridgeRes.text();
    console.error(`  ${text}`);
    process.exit(1);
  }

  const bridgeData = await bridgeRes.json() as any;
  console.log(`  Raw operationId: ${bridgeData.operationId ?? "(queued — polling needed)"}`);

  // If it queued an operation, poll for result
  if (bridgeData.operationId) {
    console.log(`  Polling for result (op=${bridgeData.operationId})...`);
    let result: any = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(
        `${BRIDGE_URL}/api/sync/status/${bridgeData.operationId}`,
        { headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" } }
      );
      const poll = await pollRes.json() as any;
      const opStatus = poll.operation?.status;
      if (opStatus === "completed") {
        result = poll;
        break;
      }
      if (opStatus === "failed" || opStatus === "error") {
        console.error(`  [!] Bridge op failed: ${JSON.stringify(poll.operation?.error)}`);
        process.exit(1);
      }
      process.stdout.write(".");
    }
    console.log("");

    if (!result) {
      console.error("  [!] Timed out waiting for bridge response");
      process.exit(1);
    }

    // Extract vendor from result — same path as qb-vendor-sync-runner
    const raw =
      result.operation?.result?.QBXML?.QBXMLMsgsRs?.VendorQueryRs?.VendorRet ?? [];
    const vendors: any[] = Array.isArray(raw) ? raw : [raw];

    if (vendors.length === 0) {
      console.log("  [!] No vendor data in response. Raw result:");
      console.log(JSON.stringify(result, null, 2).slice(0, 1000));
    } else {
      const v = vendors[0];
      console.log(`  Name:        ${v.Name ?? v.FullName}`);
      console.log(`  TermsRef:    ${JSON.stringify(v.TermsRef ?? null)}`);
      console.log(`  VendorTypeRef: ${JSON.stringify(v.VendorTypeRef ?? null)}`);
      console.log(`  IsActive:    ${v.IsActive}`);
      console.log("\n  Full response keys:", Object.keys(v).join(", "));
    }
  } else {
    // Bridge returned data synchronously
    console.log(JSON.stringify(bridgeData, null, 2).slice(0, 2000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
