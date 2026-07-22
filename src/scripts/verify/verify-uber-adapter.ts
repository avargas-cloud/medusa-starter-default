/**
 * verify-uber-adapter.ts — Fase 3 Uber Direct dispatch adapter.
 *
 * Run: set -a; source .env; set +a; ./node_modules/.bin/tsx src/scripts/verify/verify-uber-adapter.ts
 *
 * Checks (no courier is ever dispatched):
 *  1. Registry resolves "uber" and the adapter reports configured.
 *  2. Live QUOTE against the real API (free/read-only): store → Miami zip.
 *  3. SAFE-BY-DEFAULT: without UBER_DIRECT_TEST_* creds and without
 *     UBER_DIRECT_MODE=live, createLabel refuses with not_configured BEFORE
 *     any HTTP call — a dev box can never dispatch a real courier.
 *  4. voidLabel/getStatus share the same strict gate.
 */

import { getDispatchAdapter } from "../../lib/shipping-dispatch/registry";
import type { CreateLabelContext } from "../../lib/shipping-dispatch/types";
import { DispatchError } from "../../lib/shipping-dispatch/types";

const CTX: CreateLabelContext = {
  order_id: "verify_uber_adapter",
  address_to: {
    name: "Verify Script",
    street1: "1000 NW 42nd Ave",
    city: "Miami",
    state: "FL",
    zip: "33126",
    country: "US",
    phone: "3055550100",
  },
  parcels: [{ length_in: 12, width_in: 10, height_in: 6, weight_lb: 5 }],
};

async function main() {
  let failures = 0;
  const ok = (label: string) => console.log(`  ✓ ${label}`);
  const bad = (label: string) => {
    failures += 1;
    console.error(`  ✗ ${label}`);
  };

  console.log("1. registry + configuration");
  const adapter = getDispatchAdapter("uber");
  adapter.provider === "uber" ? ok("registry resolves uber") : bad("wrong provider");
  adapter.isConfigured() ? ok("isConfigured() true") : bad("isConfigured() false — creds missing?");

  console.log("2. live quote (read-only)");
  try {
    const rates = await adapter.getRates(CTX);
    const r = rates[0];
    if (
      rates.length === 1 &&
      r &&
      r.service_token === "uber_direct" &&
      r.carrier === "Uber" &&
      Number.isFinite(r.amount_cents) &&
      r.amount_cents > 0
    ) {
      ok(`quote OK — ${r.service} @ $${(r.amount_cents / 100).toFixed(2)}`);
    } else {
      bad(`unexpected rates shape: ${JSON.stringify(rates)}`);
    }
  } catch (e) {
    bad(`quote failed: ${e instanceof Error ? e.message : e}`);
  }

  const hasTestCreds = Boolean(
    process.env.UBER_DIRECT_TEST_CLIENT_ID &&
      process.env.UBER_DIRECT_TEST_CLIENT_SECRET &&
      process.env.UBER_DIRECT_TEST_CUSTOMER_ID
  );
  const liveMode = process.env.UBER_DIRECT_MODE === "live";

  console.log("3. safe-by-default gate");
  if (liveMode) {
    ok("UBER_DIRECT_MODE=live set — gate intentionally open, skipping refusal check");
  } else if (hasTestCreds) {
    ok("test creds present — create would go to the TEST env (no refusal expected)");
  } else {
    // No test creds + not live → createLabel must refuse before any HTTP.
    try {
      await adapter.createLabel(CTX);
      bad("createLabel did NOT refuse without test creds (DANGEROUS)");
    } catch (e) {
      e instanceof DispatchError && e.code === "not_configured"
        ? ok(`createLabel refused: ${e.message.slice(0, 80)}…`)
        : bad(`createLabel threw the wrong error: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await adapter.voidLabel!("del_fake");
      bad("voidLabel did NOT refuse without test creds");
    } catch (e) {
      e instanceof DispatchError && e.code === "not_configured"
        ? ok("voidLabel refused")
        : bad(`voidLabel wrong error: ${e instanceof Error ? e.message : e}`);
    }
    try {
      await adapter.getStatus!("del_fake");
      bad("getStatus did NOT refuse without test creds");
    } catch (e) {
      e instanceof DispatchError && e.code === "not_configured"
        ? ok("getStatus refused")
        : bad(`getStatus wrong error: ${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-uber-adapter crashed:", e);
  process.exit(1);
});
