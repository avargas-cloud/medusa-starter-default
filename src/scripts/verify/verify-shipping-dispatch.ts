/**
 * src/scripts/verify/verify-shipping-dispatch.ts
 *
 * Verifies Fase 0+1+2 of DELIVERY_FULFILLMENT_INTEGRATION_PLAN.md:
 *  1. DeliveryStatus state machine invariants (pure, no I/O).
 *  2. Registry resolution + safe-by-default token mode (both Shippo + UPS).
 *  3. E2E against the Shippo TEST token: quote a shipment, assert a UPS rate
 *     is present and selected, buy a test label, then void it.
 *  4. E2E against UPS-direct (Fase 2): real Rating API quote (read-only) +
 *     buy a label on the CIE test host + assert it comes back as inline
 *     base64 (not a label_url) + void.
 *
 * Run (from backend/, tsx does not auto-load .env):
 *   set -a; source .env; set +a; npx tsx src/scripts/verify/verify-shipping-dispatch.ts
 * Skip a live API leg with SKIP_SHIPPO_E2E=1 / SKIP_UPS_E2E=1.
 */

import { aggregateBoxStatuses } from "../../jobs/refresh-delivery-tracking";
import { getDispatchAdapter, listConfiguredProviders } from "../../lib/shipping-dispatch/registry";
import {
  applyStatusUpdate,
  canTransition,
  deliveryStatusFromCarrier,
  isTerminalDeliveryStatus,
} from "../../lib/shipping-dispatch/status";
import type { CreateLabelContext, DeliveryStatus } from "../../lib/shipping-dispatch/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "✅" : "❌"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function verifyStateMachine(): void {
  console.log("\n── State machine ──");
  check("happy path forward", canTransition("label_created", "in_transit"));
  check("no backwards on stale poll", !canTransition("out_for_delivery", "in_transit"));
  check("idempotent same-status", canTransition("in_transit", "in_transit"));
  check("delivered is terminal", !canTransition("delivered", "in_transit"));
  check("canceled is terminal", !canTransition("canceled", "label_created"));
  check("exception reachable from any non-terminal", canTransition("label_created", "exception"));
  check("exception recovers forward", canTransition("exception", "in_transit"));
  check("void from in_transit allowed", canTransition("in_transit", "canceled"));
  check("applyStatusUpdate blocks illegal", applyStatusUpdate("delivered", "in_transit") === null);
  check("applyStatusUpdate passes legal", applyStatusUpdate("in_transit", "delivered") === "delivered");
  check(
    "carrier mapper: delivered",
    deliveryStatusFromCarrier("delivered") === "delivered"
  );
  check(
    "carrier mapper: pending/unavailable/error → null (keep status)",
    deliveryStatusFromCarrier("pending") === null &&
      deliveryStatusFromCarrier("unavailable") === null &&
      deliveryStatusFromCarrier("error") === null
  );
  const terminals: DeliveryStatus[] = ["delivered", "canceled"];
  check(
    "terminal set",
    terminals.every(isTerminalDeliveryStatus) && !isTerminalDeliveryStatus("exception")
  );
}

function verifyMultiBoxAggregate(): void {
  console.log("\n── Multi-box aggregate ──");
  check("all delivered → delivered", aggregateBoxStatuses(["delivered", "delivered"]) === "delivered");
  check(
    "one box lagging → in_transit (NOT delivered)",
    aggregateBoxStatuses(["delivered", "in_transit"]) === "in_transit"
  );
  check(
    "delivered + no-info box → in_transit (never premature delivered)",
    aggregateBoxStatuses(["delivered", null]) === "in_transit"
  );
  check("no info at all → null (keep status)", aggregateBoxStatuses([null, null]) === null);
  check("empty → null", aggregateBoxStatuses([]) === null);
}

function verifyRegistry(): void {
  console.log("\n── Registry ──");
  const configured = listConfiguredProviders();
  check("shippo configured", configured.includes("shippo"), `configured=${configured.join(",")}`);
  let threw = false;
  try {
    getDispatchAdapter("uber");
  } catch {
    threw = true;
  }
  check("unbuilt provider throws not_configured", threw);
  check(
    "safe-by-default: not live unless SHIPPO_MODE=live",
    process.env.SHIPPO_MODE === "live" || Boolean(process.env.SHIPPO_TEST_TOKEN),
    "SHIPPO_TEST_TOKEN missing while SHIPPO_MODE != live"
  );
  check(
    "UPS-direct: safe-by-default (not live unless UPS_SHIP_MODE=live)",
    process.env.UPS_SHIP_MODE !== "live",
    "UPS_SHIP_MODE=live is set — ship/void calls below would hit PROD UPS"
  );
}

async function verifyShippoE2E(): Promise<void> {
  console.log("\n── Shippo E2E (test token) ──");
  if (process.env.SKIP_SHIPPO_E2E === "1") {
    console.log("⏭  skipped (SKIP_SHIPPO_E2E=1)");
    return;
  }
  if (process.env.SHIPPO_MODE === "live") {
    console.log("⏭  skipped — refusing to run E2E against the LIVE token");
    return;
  }
  const adapter = getDispatchAdapter("shippo");
  const ctx: CreateLabelContext = {
    order_id: "verify_order_dispatch",
    reference: "VERIFY-1",
    address_to: {
      name: "Verify Recipient",
      street1: "215 Clayton St",
      city: "San Francisco",
      state: "CA",
      zip: "94117",
      country: "US",
      phone: "+1 555 341 9393",
    },
    parcels: [{ length_in: 10, width_in: 8, height_in: 4, weight_lb: 2 }],
  };

  const rates = await adapter.getRates(ctx);
  check("getRates returns UPS rates", rates.length > 0, "no UPS rates in test mode");
  check(
    "all returned rates are UPS",
    rates.every((r) => r.carrier.toUpperCase() === "UPS"),
    rates.map((r) => r.carrier).join(",")
  );
  if (rates[0]) {
    console.log(
      `   cheapest UPS: ${rates[0].service} $${(rates[0].amount_cents / 100).toFixed(2)} (${rates[0].estimated_days ?? "?"}d)`
    );
  }

  const label = await adapter.createLabel(ctx);
  check("label bought (test)", Boolean(label.tracking_number), JSON.stringify(label));
  check("carrier is UPS", label.carrier === "UPS");
  check("label_url present", Boolean(label.label_url));
  check("rate in cents sane", label.rate_amount_cents > 0 && label.rate_amount_cents < 100_000);
  console.log(
    `   tracking=${label.tracking_number} service=${label.service} $${(label.rate_amount_cents / 100).toFixed(2)}`
  );

  if (adapter.voidLabel) {
    await adapter.voidLabel(label.provider_object_id);
    check("voidLabel accepted (refund queued)", true);
  }
}

async function verifyUpsE2E(): Promise<void> {
  console.log("\n── UPS-direct E2E (CIE test host) ──");
  if (process.env.SKIP_UPS_E2E === "1") {
    console.log("⏭  skipped (SKIP_UPS_E2E=1)");
    return;
  }
  if (!listConfiguredProviders().includes("ups")) {
    console.log("⏭  skipped — UPS not configured (missing UPS_CLIENT_ID/SECRET/UPS_SHIPPER_NUMBER)");
    return;
  }
  if (process.env.UPS_SHIP_MODE === "live") {
    console.log("⏭  skipped — refusing to run E2E against LIVE UPS shipping");
    return;
  }
  const adapter = getDispatchAdapter("ups");
  const ctx: CreateLabelContext = {
    order_id: "verify_order_dispatch_ups",
    reference: "VERIFY-UPS-1",
    address_to: {
      name: "Verify Recipient",
      street1: "215 Clayton St",
      city: "San Francisco",
      state: "CA",
      zip: "94117",
      country: "US",
      phone: "+1 555 341 9393",
    },
    parcels: [{ length_in: 10, width_in: 8, height_in: 4, weight_lb: 2 }],
  };

  // Rating is read-only and always hits real UPS, even in test mode.
  const rates = await adapter.getRates(ctx);
  check("getRates returns UPS rates", rates.length > 0, "no rates returned");
  check(
    "all returned rates are UPS with ups_* service_token",
    rates.every((r) => r.carrier === "UPS" && r.service_token.startsWith("ups_")),
    rates.map((r) => r.service_token).join(",")
  );
  if (rates[0]) {
    console.log(
      `   cheapest UPS (negotiated if available): ${rates[0].service} $${(rates[0].amount_cents / 100).toFixed(2)} (${rates[0].estimated_days ?? "?"}d)`
    );
  }

  const label = await adapter.createLabel(ctx);
  check("label bought (CIE test)", Boolean(label.tracking_number), JSON.stringify(label));
  check("carrier is UPS", label.carrier === "UPS");
  check(
    "label returned INLINE as base64 (no CDN url) — the create-shipment gap this session fixed",
    label.packages[0]?.label_url === null && Boolean(label.packages[0]?.label_base64),
    JSON.stringify(label.packages[0])
  );
  check(
    "label_mime is set for the base64 payload",
    Boolean(label.packages[0]?.label_mime),
    label.packages[0]?.label_mime ?? "missing"
  );
  check("rate in cents sane", label.rate_amount_cents >= 0 && label.rate_amount_cents < 100_000);
  console.log(
    `   tracking=${label.tracking_number} service=${label.service} $${(label.rate_amount_cents / 100).toFixed(2)}`
  );

  if (adapter.voidLabel) {
    try {
      await adapter.voidLabel(label.provider_object_id);
      check("voidLabel accepted", true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/190102|allowed void period/i.test(msg)) {
        // Known UPS CIE (test host) quirk: test shipments are frequently not
        // voidable at all — not something our code controls, so don't fail
        // the run over it. Real UPS_SHIP_MODE=live shipments void fine.
        console.log(`⏭  voidLabel — CIE test host quirk (${msg}), not a code defect`);
      } else {
        throw err;
      }
    }
  }
}

async function main(): Promise<void> {
  verifyStateMachine();
  verifyMultiBoxAggregate();
  verifyRegistry();
  try {
    await verifyShippoE2E();
  } catch (err) {
    check(
      "Shippo E2E",
      false,
      err instanceof Error ? err.message : String(err)
    );
  }
  try {
    await verifyUpsE2E();
  } catch (err) {
    check(
      "UPS-direct E2E",
      false,
      err instanceof Error ? err.message : String(err)
    );
  }
  console.log(failures === 0 ? "\n✓ ALL CHECKS PASSED" : `\n✗ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
