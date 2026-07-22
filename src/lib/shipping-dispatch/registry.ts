/**
 * src/lib/shipping-dispatch/registry.ts
 *
 * provider → DispatchAdapter map (parity with ADAPTERS in
 * lib/carrier-tracking/index.ts). UPS-direct (Fase 2) and Uber (Fase 3)
 * register here when built — the rest of the stack is provider-agnostic.
 */

import { shippoAdapter } from "./shippo-adapter";
import { uberDispatchAdapter } from "./uber-adapter";
import { upsDispatchAdapter } from "./ups-adapter";
import type { DeliveryProvider, DispatchAdapter } from "./types";
import { DispatchError } from "./types";

const ADAPTERS: Partial<Record<DeliveryProvider, DispatchAdapter>> = {
  shippo: shippoAdapter,
  ups: upsDispatchAdapter, // Fase 2 — live only once the UPS app has the "Shipping" product
  uber: uberDispatchAdapter, // Fase 3 — per-order same-day courier (never the global default)
};

export function getDispatchAdapter(provider: string): DispatchAdapter {
  const adapter = ADAPTERS[provider as DeliveryProvider];
  if (!adapter) {
    throw new DispatchError(
      "not_configured",
      `No dispatch adapter for provider "${provider}"`
    );
  }
  if (!adapter.isConfigured()) {
    throw new DispatchError(
      "not_configured",
      `Dispatch provider "${provider}" is not configured (missing env credentials)`
    );
  }
  return adapter;
}

/** Providers currently usable (configured), for the POS provider picker. */
export function listConfiguredProviders(): DeliveryProvider[] {
  return (Object.keys(ADAPTERS) as DeliveryProvider[]).filter((p) =>
    ADAPTERS[p]?.isConfigured()
  );
}
