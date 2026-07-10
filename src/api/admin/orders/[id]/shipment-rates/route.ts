/**
 * POST /admin/orders/:id/shipment-rates
 *
 * Quote shipping rates for an order (NO purchase, no side effects on our
 * side). The DispatchModal calls this every time the cashier edits the
 * package dims/weight, then buys via create-shipment with the chosen service.
 *
 * Body:
 *   parcels: { length_in, width_in, height_in, weight_lb }[]   required
 *   provider?: "shippo" (default)
 *   address_to?: DispatchAddress   override — default = order shipping address
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { resolveDispatchProvider } from "../../../../../lib/shipping-dispatch/default-provider";
import { getDispatchAdapter } from "../../../../../lib/shipping-dispatch/registry";
import type {
  DispatchAddress,
  DispatchParcel,
} from "../../../../../lib/shipping-dispatch/types";
import { DispatchError } from "../../../../../lib/shipping-dispatch/types";
import { getDbPool } from "../../../../utils/db-pool";
import { loadOrderShipTo } from "../create-shipment/_lib/resolve";

const DISPATCH_HTTP_STATUS: Record<DispatchError["code"], number> = {
  invalid_address: 400,
  no_ups_rate: 422,
  provider_error: 502,
  not_configured: 503,
};

interface RatesBody {
  parcels: DispatchParcel[];
  provider?: string;
  address_to?: DispatchAddress;
}

function validParcels(parcels: unknown): parcels is DispatchParcel[] {
  return (
    Array.isArray(parcels) &&
    parcels.length > 0 &&
    parcels.every(
      (p) =>
        p &&
        typeof p === "object" &&
        [
          (p as DispatchParcel).length_in,
          (p as DispatchParcel).width_in,
          (p as DispatchParcel).height_in,
          (p as DispatchParcel).weight_lb,
        ].every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    )
  );
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id as string;
  const body = req.body as RatesBody;

  if (!validParcels(body.parcels)) {
    return res.status(400).json({
      code: "invalid_parcels",
      message: "parcels[] with positive length_in/width_in/height_in/weight_lb is required",
    });
  }

  try {
    const adapter = getDispatchAdapter(
      await resolveDispatchProvider(getDbPool(), body.provider)
    );
    const address_to =
      body.address_to ?? (await loadOrderShipTo(getDbPool(), orderId));
    const rates = await adapter.getRates({
      order_id: orderId,
      address_to,
      parcels: body.parcels,
    });
    return res.json({ rates, address_to });
  } catch (err) {
    if (err instanceof DispatchError) {
      return res
        .status(DISPATCH_HTTP_STATUS[err.code])
        .json({ code: err.code, message: err.message });
    }
    console.error("[shipment-rates]", err);
    return res.status(500).json({
      code: "unknown",
      message: err instanceof Error ? err.message : "Failed to quote rates",
    });
  }
}
