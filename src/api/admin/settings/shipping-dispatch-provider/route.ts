/**
 * GET /admin/settings/shipping-dispatch-provider → { provider, configured }
 * PUT /admin/settings/shipping-dispatch-provider → set the default REGULAR
 *   parcel-label provider used when create-shipment/shipment-rates don't say
 *   one explicitly.
 *
 * Scope: this is a choice between INTERCHANGEABLE engines for the same job
 * (buy a standard carrier label) — Shippo vs UPS-direct vs (future) FedEx.
 * Uber Direct is NOT a candidate here: it's a distinct delivery METHOD (local
 * same-day courier), not an alternate engine for the same parcel label. Once
 * built, Uber should be selected PER-ORDER from the order's shipping
 * method/option (DispatchModal detects it and routes to the Uber adapter
 * directly) — never via this global default.
 *
 * Storage: system_defaults (context='shipping', field_name='dispatch_provider')
 * — same table `lib/shipping-dispatch/default-provider.ts` reads at request
 * time (`ORDER BY sort_order ASC LIMIT 1`). The PUT keeps exactly ONE row for
 * this (context, field_name) pair — a delete+insert, not an upsert into a
 * dropdown-options list like PO Status — so there's never ambiguity about
 * which value "wins". Selecting a provider that isn't configured yet
 * (missing env creds) is allowed on purpose: the registry fails clean with
 * `not_configured` downstream, never a silent fallback (see default-provider.ts).
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../../utils/db-pool";
import { resolveDispatchProvider } from "../../../../lib/shipping-dispatch/default-provider";
import { listConfiguredProviders } from "../../../../lib/shipping-dispatch/registry";
import type { DeliveryProvider } from "../../../../lib/shipping-dispatch/types";

// Regular parcel-label engines only — Uber Direct is a per-order method
// (see file header), never a global default here.
const KNOWN_PROVIDERS: DeliveryProvider[] = ["shippo", "ups", "fedex"];

export async function GET(
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    const pool = getDbPool();
    const provider = await resolveDispatchProvider(pool);
    return res.json({ provider, configured: listConfiguredProviders() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

export async function PUT(
  req: AuthenticatedMedusaRequest<{ provider?: string }>,
  res: MedusaResponse
) {
  const provider = req.body.provider?.trim().toLowerCase();
  if (!provider || !KNOWN_PROVIDERS.includes(provider as DeliveryProvider)) {
    return res.status(400).json({
      error: `provider must be one of: ${KNOWN_PROVIDERS.join(", ")}`,
    });
  }

  try {
    const pool = getDbPool();
    await pool.query(
      `DELETE FROM system_defaults WHERE context = 'shipping' AND field_name = 'dispatch_provider'`
    );
    await pool.query(
      `INSERT INTO system_defaults (context, field_name, value, sort_order, data_scope)
       VALUES ('shipping', 'dispatch_provider', $1, 1, 'orders')`,
      [provider]
    );
    return res.json({ provider, configured: listConfiguredProviders() });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
