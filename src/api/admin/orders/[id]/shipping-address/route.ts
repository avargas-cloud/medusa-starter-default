/**
 * GET/PATCH /admin/orders/:id/shipping-address
 *
 * Ship-to address for the DispatchModal (Create Shipping Label) — reads and
 * writes the order's OWN address (order_address via order.shipping_address_id),
 * not a pos_invoice snapshot. Invoices are immutable once created (store-pos
 * CLAUDE.md — "invoices/ ... son legalmente cerradas"), but the shipping
 * address is NOT part of that frozen fiscal snapshot: it's live fulfillment
 * data. Correcting a typo here is safe and persists everywhere downstream —
 * shipment-rates/create-shipment already fall back to `loadOrderShipTo` when
 * no explicit `address_to` is passed in the request body, so a PATCH here is
 * picked up automatically on the next quote/purchase with zero extra wiring.
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { generateEntityId } from "@medusajs/utils";

import { getDbPool } from "../../../../utils/db-pool";

interface ShippingAddressPayload {
  name: string;
  company?: string | null;
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string | null;
}

interface AddressRow {
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  country_code: string | null;
  phone: string | null;
}

function toPayload(r: AddressRow): ShippingAddressPayload {
  return {
    name: [r.first_name, r.last_name].filter(Boolean).join(" "),
    company: r.company ?? "",
    street1: r.address_1 ?? "",
    street2: r.address_2 ?? "",
    city: r.city ?? "",
    state: r.province ?? "",
    zip: r.postal_code ?? "",
    country: (r.country_code ?? "us").toUpperCase(),
    phone: r.phone ?? "",
  };
}

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params;
  const pool = getDbPool();
  const { rows } = await pool.query<AddressRow>(
    `SELECT oa.first_name, oa.last_name, oa.company, oa.address_1, oa.address_2,
            oa.city, oa.province, oa.postal_code, oa.country_code, oa.phone
       FROM "order" o
       LEFT JOIN order_address oa ON oa.id = o.shipping_address_id
      WHERE o.id = $1`,
    [orderId]
  );
  if (!rows[0]) return res.status(404).json({ error: "Order not found" });

  // Current shipping method LABEL (name) + billed amount — display-only here,
  // never mutated by this route. The amount is what's frozen on the invoice;
  // see shipping-method-label/route.ts for the (name-only, amount-never)
  // update DispatchModal uses after buying a label with a different carrier.
  const { rows: smRows } = await pool.query<{ name: string; amount: string }>(
    `SELECT osm.name, osm.amount
       FROM order_shipping os
       JOIN order_shipping_method osm ON osm.id = os.shipping_method_id
       JOIN "order" o ON o.id = os.order_id AND o.version = os.version
      WHERE os.order_id = $1 AND os.deleted_at IS NULL
      ORDER BY os.created_at DESC LIMIT 1`,
    [orderId]
  );
  const shippingMethod = smRows[0]
    ? { name: smRows[0].name, amount_cents: Math.round(Number(smRows[0].amount) * 100) }
    : null;

  return res.json({ address: toPayload(rows[0]), shipping_method: shippingMethod });
}

export async function PATCH(
  req: AuthenticatedMedusaRequest<ShippingAddressPayload>,
  res: MedusaResponse
) {
  const { id: orderId } = req.params;
  const b = req.body;
  if (!b.street1?.trim() || !b.city?.trim() || !b.state?.trim() || !b.zip?.trim() || !b.country?.trim()) {
    return res
      .status(400)
      .json({ error: "street1, city, state, zip and country are required" });
  }

  const pool = getDbPool();

  // Locked once a label has shipped to this address — a live edit here would
  // silently diverge from what the carrier already has on file for a label
  // in flight. Void the label first (frees the lock) to correct it.
  const { rows: activeLabels } = await pool.query<{ id: string }>(
    `SELECT id FROM order_delivery
      WHERE order_id = $1 AND deleted_at IS NULL AND voided_at IS NULL
        AND provider_object_id IS NOT NULL
      LIMIT 1`,
    [orderId]
  );
  if (activeLabels[0]) {
    return res.status(409).json({
      error: "Shipping address is locked — void the existing label(s) before editing it",
    });
  }

  const nameParts = (b.name ?? "").trim().split(/\s+/).filter(Boolean);
  const first_name = nameParts[0] ?? "";
  const last_name = nameParts.slice(1).join(" ");

  const { rows: orderRows } = await pool.query<{ shipping_address_id: string | null }>(
    `SELECT shipping_address_id FROM "order" WHERE id = $1`,
    [orderId]
  );
  if (!orderRows[0]) return res.status(404).json({ error: "Order not found" });

  const existingId = orderRows[0].shipping_address_id;
  const values = [
    first_name,
    last_name,
    b.company?.trim() || null,
    b.street1.trim(),
    b.street2?.trim() || null,
    b.city.trim(),
    b.state.trim(),
    b.zip.trim(),
    b.country.trim().toLowerCase(),
    b.phone?.trim() || null,
  ];

  try {
    if (existingId) {
      await pool.query(
        `UPDATE order_address
            SET first_name = $1, last_name = $2, company = $3, address_1 = $4,
                address_2 = $5, city = $6, province = $7, postal_code = $8,
                country_code = $9, phone = $10, updated_at = NOW()
          WHERE id = $11`,
        [...values, existingId]
      );
    } else {
      const newId = generateEntityId("", "ordaddr");
      await pool.query(
        `INSERT INTO order_address
           (id, first_name, last_name, company, address_1, address_2, city,
            province, postal_code, country_code, phone, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), NOW())`,
        [newId, ...values]
      );
      await pool.query(`UPDATE "order" SET shipping_address_id = $1 WHERE id = $2`, [
        newId,
        orderId,
      ]);
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }

  return res.json({
    address: { ...b, country: b.country.trim().toUpperCase() },
  });
}
