import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { getUPSRate } from "../../../modules/ups-rate-cache";
import { Client } from "pg";

/**
 * GET /admin/ups-rate-preview
 *
 * Returns real-time UPS rates for all services given:
 *  - postal_code (required)
 *  - draft_order_id (optional) — fetches items + dimensions from DB
 *
 * Returns rates in DOLLARS for all service codes.
 * Uses the same getUPSRate() Shop API as the fulfillment providers.
 */

// UPS service code → human name map
const SERVICE_CODES: Record<string, string> = {
  "01": "UPS Next Day Air",
  "02": "UPS 2nd Day Air",
  "03": "UPS Ground",
  "12": "UPS 3 Day Select",
};

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const postalCode = (req.query?.postal_code as string | undefined)?.trim();
  const draftOrderId = req.query?.draft_order_id as string | undefined;

  if (!postalCode) {
    return res.status(400).json({ error: "postal_code query param required" });
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // ── 1. Fetch items + dimensions from DB ─────────────────────────────────
    let items: {
      weight: number;
      length: number;
      width: number;
      height: number;
      quantity: number;
    }[] = [];
    let shipToName = "";
    let shipToAddress = "";
    let shipToCity = "";
    let shipToState = "";
    let shipToCountry = "US";

    if (draftOrderId) {
      // Get shipping address from order
      const addrRes = await client.query(
        `
                SELECT o.shipping_address_id, sa.first_name, sa.last_name, sa.company,
                       sa.address_1, sa.city, sa.province, sa.country_code
                FROM "order" o
                LEFT JOIN order_address sa ON sa.id = o.shipping_address_id
                WHERE o.id = $1 AND o.deleted_at IS NULL
                LIMIT 1
            `,
        [draftOrderId]
      );

      if (addrRes.rows[0]) {
        const a = addrRes.rows[0];
        shipToName =
          a.company || `${a.first_name || ""} ${a.last_name || ""}`.trim();
        shipToAddress = a.address_1 || "";
        shipToCity = a.city || "";
        shipToState = a.province || "";
        shipToCountry = (a.country_code || "us").toUpperCase();
      }

      // Fetch items with dimensions via order_item → order_line_item bridge.
      // IMPORTANT: order_line_item has NO order_id column in Medusa v2.
      // Items are linked through: order_item.item_id → order_line_item.id
      const itemsRes = await client.query(
        `
                SELECT
                    oitem.quantity,
                    COALESCE(ii.weight, pv.weight, 1)::float   AS weight,
                    COALESCE(ii.length, pv.length, 6)::float   AS length,
                    COALESCE(ii.width,  pv.width,  6)::float   AS width,
                    COALESCE(ii.height, pv.height, 6)::float   AS height
                FROM order_item oitem
                JOIN order_line_item oli ON oli.id = oitem.item_id
                JOIN product_variant pv ON pv.id = oli.variant_id
                LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
                LEFT JOIN inventory_item ii ON ii.id = pvii.inventory_item_id
                WHERE oitem.order_id = $1
                  AND oli.deleted_at IS NULL
                  AND oitem.deleted_at IS NULL
            `,
        [draftOrderId]
      );

      items = itemsRes.rows;
    }

    // ── 2. Default package if no items found ─────────────────────────────────
    if (items.length === 0) {
      items = [{ weight: 5, length: 12, width: 10, height: 8, quantity: 1 }];
    }

    // ── 3. Box packing (simplified: one package per item × quantity) ─────────
    const packages = items.flatMap((i) => {
      const count = i.quantity || 1;
      return Array.from({ length: count }, () => ({
        weight: i.weight || 1,
        length: i.length || 6,
        width: i.width || 6,
        height: i.height || 6,
      }));
    });
    // Aggregate into one package for simplicity (sum weights, max dims)
    const singlePkg = packages.reduce(
      (acc, p) => ({
        weight: acc.weight + p.weight,
        length: Math.max(acc.length, p.length),
        width: Math.max(acc.width, p.width),
        height: Math.max(acc.height, p.height),
      }),
      { weight: 0, length: 0, width: 0, height: 0 }
    );
    if (singlePkg.weight === 0) singlePkg.weight = 5;

    const cacheId = `pos-preview-${postalCode}`;

    // ── 4. Get all UPS rates in one Shop API call ─────────────────────────────
    const rates: Record<string, number> = {};
    const serviceCodes = Object.keys(SERVICE_CODES);

    // First call fetches all from UPS Shop API and caches; subsequent calls use cache
    for (const code of serviceCodes) {
      try {
        const priceCents = await getUPSRate(code, {
          cartId: cacheId,
          postalCode,
          packages: [singlePkg],
          shipperName: process.env.UPS_ORIGIN_NAME || "Ecopowertech Inc",
          shipperAddress:
            process.env.UPS_ORIGIN_ADDRESS || "2760 W 84th St Unit 4",
          shipperCity: process.env.UPS_ORIGIN_CITY || "Hialeah",
          shipperState: process.env.UPS_ORIGIN_STATE || "FL",
          shipperZip: process.env.UPS_ORIGIN_ZIP || "33016",
          shipperCountry: process.env.UPS_ORIGIN_COUNTRY || "US",
          shipToName,
          shipToAddress,
          shipToCity,
          shipToState,
          shipToCountry,
        });
        if (priceCents !== null) {
          rates[code] = priceCents / 100; // dollars
        }
      } catch {
        // Rate unavailable for this service — skip
      }
    }

    return res.json({ rates, postal_code: postalCode });
  } catch (err: any) {
    console.error("[ups-rate-preview]", err);
    return res
      .status(500)
      .json({ error: "Failed to get UPS rates", details: err.message });
  } finally {
    await client.end();
  }
};
