/**
 * src/lib/shipping-dispatch/types.ts
 *
 * Shared types for the shipping-dispatch layer (label creation / courier
 * dispatch for CUSTOMER orders). Each provider (Shippo / UPS-direct / Uber)
 * implements `DispatchAdapter`; the registry resolves provider → adapter.
 *
 * Distinct from lib/carrier-tracking (read-only PO ETA lookups): that layer
 * is REUSED for polling parcel status, but dispatch (buying labels) is new.
 * See DELIVERY_FULFILLMENT_INTEGRATION_PLAN.md §5 Fase 0.
 */

/**
 * "fedex" is a placeholder — surfaced in the admin provider picker for a
 * future adapter, but no DispatchAdapter is registered for it yet (unlike
 * lib/carrier-tracking, where FedEx already exists for read-only PO ETA
 * lookups — a different subsystem from buying customer shipping labels).
 */
export type DeliveryProvider = "shippo" | "ups" | "uber" | "fedex";

/**
 * Explicit shipment state machine (plan §Fase 0). The PO-oriented
 * CarrierStatus (`pending|in_transit|delivered|unavailable|error`) is
 * date/ETA-oriented and does not cover a customer shipment's lifecycle.
 */
export type DeliveryStatus =
  | "label_created" // label bought / dispatch created — order is fulfilled NOW
  | "pending_pickup" // carrier/courier notified, package not scanned yet
  | "in_transit" // carrier scanned / courier picked up
  | "out_for_delivery"
  | "delivered" // terminal — leaves the poll query
  | "exception" // carrier reported a problem — needs human attention
  | "failed" // dispatch/courier failed (e.g. Uber could not deliver)
  | "canceled"; // label voided / dispatch canceled — terminal

/** A parcel to ship. Inches + pounds (UPS/Shippo default units). */
export interface DispatchParcel {
  length_in: number;
  width_in: number;
  height_in: number;
  weight_lb: number;
}

/** Destination address, already sanitized by the caller. */
export interface DispatchAddress {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string; // ISO-2, e.g. "US"
  phone?: string;
  email?: string;
}

/** Input to createLabel. `order_id` is stamped on the provider object as the
 * join key for webhooks/polls (Shippo `metadata`, Uber `external_order_id`). */
export interface CreateLabelContext {
  order_id: string;
  /** Human reference printed on the label where supported (e.g. "S2450"). */
  reference?: string;
  address_to: DispatchAddress;
  parcels: DispatchParcel[];
  /** Provider-specific service token (e.g. "ups_ground"). Omit = cheapest UPS. */
  service?: string;
}

/** One physical package's label within a (possibly multi-box) shipment. */
export interface LabelPackage {
  /** Provider transaction id for THIS box (master box = provider_object_id). */
  provider_object_id: string;
  tracking_number: string;
  tracking_url: string | null;
  label_url: string | null;
  /** Label image returned INLINE by the provider (UPS-direct: base64 GIF,
   * no CDN URL). Consumed + STRIPPED by the re-host step — never persisted. */
  label_base64?: string | null;
  /** Mime of `label_base64` (e.g. "image/gif"). */
  label_mime?: string | null;
}

/** Result of a successful label purchase / dispatch creation. */
export interface CreateLabelResult {
  provider: DeliveryProvider;
  /** Provider object id used for void/refund (Shippo transaction object_id,
   * Uber delivery id). Internal only. */
  provider_object_id: string;
  carrier: string;
  service: string | null;
  tracking_number: string;
  /** Provider-hosted live tracking page (customer-facing once validated). */
  tracking_url: string | null;
  /** Label PDF/PNG — internal/POS printing only. Null for Uber. */
  label_url: string | null;
  /** Rate actually charged, in cents. Per plan §2, when brokered via Shippo
   * this is ALWAYS the UPS carrier rate — never Shippo's own/marked rate. */
  rate_amount_cents: number;
  rate_currency: string;
  /** One entry per physical box (UPS multi-piece: ONE purchase → N labels,
   * each box with its own tracking + label). Single-box = 1 entry. */
  packages: LabelPackage[];
  /** Raw provider snapshot worth persisting for diagnostics. */
  raw?: Record<string, unknown>;
}

/** A rate option shown to the cashier before buying. */
export interface RateOption {
  rate_id: string;
  carrier: string;
  service: string;
  service_token: string;
  amount_cents: number;
  currency: string;
  /** Transit estimate in days when the provider reports one. */
  estimated_days: number | null;
}

/** Normalized status probe result (poll cron / on-demand refresh). */
export interface DeliveryStatusUpdate {
  status: DeliveryStatus;
  detail: string | null;
  /** Actual delivery timestamp when the provider reports one. */
  delivered_at: string | null;
}

export interface DispatchAdapter {
  readonly provider: DeliveryProvider;
  /** True when env credentials are present and the adapter can run. */
  isConfigured(): boolean;
  /** Quote available rates for a shipment (no purchase). Throws on API error. */
  getRates(ctx: CreateLabelContext): Promise<RateOption[]>;
  /** Buy the label / create the dispatch. Throws on failure — the caller
   * (create-shipment command) owns idempotency and persistence. */
  createLabel(ctx: CreateLabelContext): Promise<CreateLabelResult>;
  /** Poll shipment status. Parcel carriers may omit this — the orchestrator
   * falls back to lib/carrier-tracking by tracking number. */
  getStatus?(providerObjectId: string): Promise<DeliveryStatusUpdate>;
  /** Void/refund the label (Shippo refund / Uber cancel). Idempotent. */
  voidLabel?(providerObjectId: string): Promise<void>;
}

/** Error with a stable code the POS can branch on. */
export class DispatchError extends Error {
  constructor(
    public readonly code:
      | "not_configured"
      | "no_ups_rate"
      | "provider_error"
      | "invalid_address",
    message: string
  ) {
    super(message);
    this.name = "DispatchError";
  }
}
