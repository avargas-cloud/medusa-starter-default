/**
 * Verifies B1 fix: pollBridgeStatus() returns { status: "expired" } on HTTP 404
 * instead of throwing, so callers can branch and clear stuck operations.
 *
 * Run: yarn ts-node src/scripts/verify/verify-bridge-fetch-404.ts
 */
import {
  pollBridgeStatus,
  bridgeFetch,
  BridgeFetchError,
} from "../../lib/quickbooks/bridge-fetch";

const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: unknown = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

function restore() {
  globalThis.fetch = originalFetch;
}

async function assertEquals(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`❌ ${label}\n   expected: ${e}\n   got:      ${a}`);
    process.exit(1);
  }
  console.log(`✅ ${label}`);
}

async function main() {
  // Need a fake URL so bridgeUrl() doesn't throw
  process.env.QB_BRIDGE_URL = "http://test.local";

  // Test 1: 404 → expired sentinel
  mockFetch(404);
  const r1 = await pollBridgeStatus("fake-op-1");
  await assertEquals(r1, { status: "expired" }, "404 → expired sentinel");

  // Test 2: 200 with status:"completed" → normal pass-through
  mockFetch(200, { operation: { status: "completed", txnId: "ABC-123" } });
  const r2 = await pollBridgeStatus("fake-op-2");
  if (r2.status !== "completed") {
    console.error(`❌ 200 status mismatch: ${JSON.stringify(r2)}`);
    process.exit(1);
  }
  console.log("✅ 200 → completed pass-through");

  // Test 3: 500 → BridgeFetchError thrown
  mockFetch(500, { error: "internal" });
  try {
    await pollBridgeStatus("fake-op-3");
    console.error("❌ 500 should have thrown");
    process.exit(1);
  } catch (err) {
    if (err instanceof BridgeFetchError && err.status === 500 && !err.isExpired) {
      console.log("✅ 500 → BridgeFetchError(500, isExpired=false)");
    } else {
      console.error(`❌ 500 wrong error: ${err}`);
      process.exit(1);
    }
  }

  // Test 4: bridgeFetch directly throws on 404 with isExpired
  mockFetch(404);
  try {
    await bridgeFetch("/api/sync/status/missing");
    console.error("❌ bridgeFetch should throw on 404");
    process.exit(1);
  } catch (err) {
    if (err instanceof BridgeFetchError && err.status === 404 && err.isExpired) {
      console.log("✅ bridgeFetch(404) → BridgeFetchError(isExpired=true)");
    } else {
      console.error(`❌ wrong error: ${err}`);
      process.exit(1);
    }
  }

  restore();
  console.log("\n🎉 B1 verification PASSED — Bridge 404 handling correct.");
}

main().catch((err) => {
  console.error("Verification crashed:", err);
  process.exit(1);
});
