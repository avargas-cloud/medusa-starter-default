import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Client } from "pg";

// CORS helper (same pattern as shipping-settings)
function setCorsHeaders(req: MedusaRequest, res: MedusaResponse) {
  const origin = req.headers.origin || "";
  const allowedOrigins = (
    process.env.STORE_CORS || "http://localhost:4321,http://localhost:8000"
  ).split(",");
  if (
    allowedOrigins.includes(origin) ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("https://localhost")
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-publishable-api-key"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

export const OPTIONS = async (req: MedusaRequest, res: MedusaResponse) => {
  setCorsHeaders(req, res);
  res.status(204).end();
};

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  setCorsHeaders(req, res);

  const body = req.body as {
    variant_ids?: string[];
    cart_total_cents?: number;
  };
  if (!body || !Array.isArray(body.variant_ids)) {
    res.status(400).json({ error: "variant_ids array required" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    const settingsResult = await client.query(`
            SELECT
                free_shipping_minimum,
                regular_ground_shipping_price,
                long_item_ground_shipping_price,
                override_ups_ground
            FROM shipping_settings
            LIMIT 1
        `);

    const settings = settingsResult.rows[0] || {
      free_shipping_minimum: 20000,
      regular_ground_shipping_price: 1499,
      long_item_ground_shipping_price: 3499,
      override_ups_ground: true,
    };

    const variantIds = body.variant_ids.filter(Boolean);
    const cartTotalCents = body.cart_total_cents || 0;

    const isFree = cartTotalCents >= settings.free_shipping_minimum;

    let isLong = false;
    const LONG_THRESHOLD = 30;

    if (!isFree && variantIds.length > 0) {
      const longViaInv = await client.query(
        `
                SELECT pv.id
                FROM product_variant pv
                JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
                JOIN inventory_item ii ON ii.id = pvii.inventory_item_id
                WHERE pv.id = ANY($1)
                  AND (ii.length > $2 OR ii.width > $2 OR ii.height > $2)
                LIMIT 1
            `,
        [variantIds, LONG_THRESHOLD]
      );

      if (longViaInv.rows.length > 0) {
        isLong = true;
      } else {
        const longViaVariant = await client.query(
          `
                    SELECT id FROM product_variant
                    WHERE id = ANY($1)
                      AND (length > $2 OR width > $2 OR height > $2)
                    LIMIT 1
                `,
          [variantIds, LONG_THRESHOLD]
        );
        isLong = longViaVariant.rows.length > 0;
      }
    }

    let priceCents = 0;
    if (isFree) {
      priceCents = 0;
    } else if (isLong) {
      priceCents = settings.long_item_ground_shipping_price;
    } else {
      priceCents = settings.regular_ground_shipping_price;
    }

    res.json({
      ground: {
        price: priceCents / 100,
        price_cents: priceCents,
        is_free: isFree,
        is_long: isLong,
      },
      settings,
      cart_total_cents: cartTotalCents,
    });
  } catch (error: any) {
    console.error("Error in POST /shipping-preview:", error);
    res.status(500).json({
      error: "Failed to calculate shipping preview",
      details: error.message,
    });
  } finally {
    await client.end();
  }
};

/**
 * GET /shipping-preview?cart_id=cart_xxx
 * GET /shipping-preview?order_id=order_xxx   ← also accepts draft-order IDs
 *
 * Fast endpoint (~100-150ms) that returns the correct ground shipping price,
 * including long-item detection via direct DB query.
 *
 * cart_id path: reads from cart_line_item (storefront carts)
 * order_id path: reads from order_line_item (POS add-item-force draft orders)
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  setCorsHeaders(req, res);

  const cartId = req.query?.cart_id as string | undefined;
  const orderId = req.query?.order_id as string | undefined;

  if (!cartId && !orderId) {
    res.status(400).json({ error: "cart_id or order_id query param required" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });

  try {
    await client.connect();

    // 1. Fetch shipping settings
    const settingsResult = await client.query(`
            SELECT
                free_shipping_minimum,
                regular_ground_shipping_price,
                long_item_ground_shipping_price,
                override_ups_ground
            FROM shipping_settings
            LIMIT 1
        `);

    const settings = settingsResult.rows[0] || {
      free_shipping_minimum: 20000,
      regular_ground_shipping_price: 1499,
      long_item_ground_shipping_price: 3499,
      override_ups_ground: true,
    };

    let variantIds: string[] = [];
    let cartTotalCents = 0;

    if (orderId) {
      // ── Order path (POS draft orders via add-item-force) ──
      // order_line_item prices are in DOLLARS (not cents) — add-item-force convention
      const itemsResult = await client.query(
        `
                SELECT oli.variant_id, oli.unit_price, oi.quantity
                FROM order_line_item oli
                JOIN order_item oi ON oi.item_id = oli.id
                WHERE oi.order_id = $1
                  AND oli.deleted_at IS NULL
                  AND oi.deleted_at IS NULL
                ORDER BY oi.version DESC
            `,
        [orderId]
      );

      // Deduplicate to latest version per item
      const seen = new Set<string>();
      const items: {
        variant_id: string;
        unit_price: number;
        quantity: number;
      }[] = [];
      for (const row of itemsResult.rows) {
        if (!seen.has(row.variant_id)) {
          seen.add(row.variant_id);
          items.push(row);
        }
      }

      // unit_price is in dollars for order_line_item → multiply by 100 for cents
      cartTotalCents = items.reduce(
        (sum, item) =>
          sum + Math.round(Number(item.unit_price) * item.quantity * 100),
        0
      );
      variantIds = items.map((i) => i.variant_id).filter(Boolean);
    } else {
      // ── Cart path (storefront carts) ──
      const itemsResult = await client.query(
        `
                SELECT cli.variant_id, cli.unit_price, cli.quantity
                FROM cart_line_item cli
                WHERE cli.cart_id = $1
                  AND cli.deleted_at IS NULL
            `,
        [cartId]
      );

      const items = itemsResult.rows;
      // unit_price is in cents for cart_line_item
      cartTotalCents = items.reduce(
        (sum: number, item: any) =>
          sum + Math.round(item.unit_price * item.quantity * 100),
        0
      );
      variantIds = items.map((i: any) => i.variant_id).filter(Boolean);
    }

    const isFree = cartTotalCents >= settings.free_shipping_minimum;

    // 2. Check for long items by dimensions (> 30") — reads inventory_item first, then variant fallback
    let isLong = false;
    const LONG_THRESHOLD = 30; // inches — same as box-packing.ts

    if (!isFree && variantIds.length > 0) {
      // Primary: inventory_item dimensions (where the admin widget saves)
      const longViaInv = await client.query(
        `
                SELECT pv.id, pv.sku, ii.length, ii.width, ii.height
                FROM product_variant pv
                JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id
                JOIN inventory_item ii ON ii.id = pvii.inventory_item_id
                WHERE pv.id = ANY($1)
                  AND (ii.length > $2 OR ii.width > $2 OR ii.height > $2)
                LIMIT 1
            `,
        [variantIds, LONG_THRESHOLD]
      );

      if (longViaInv.rows.length > 0) {
        isLong = true;
      } else {
        // Fallback: product_variant dimensions
        const longViaVariant = await client.query(
          `
                    SELECT id FROM product_variant
                    WHERE id = ANY($1)
                      AND (length > $2 OR width > $2 OR height > $2)
                    LIMIT 1
                `,
          [variantIds, LONG_THRESHOLD]
        );
        isLong = longViaVariant.rows.length > 0;
      }
    }

    // 3. Calculate ground shipping price
    let priceCents = 0;
    if (isFree) {
      priceCents = 0;
    } else if (isLong) {
      priceCents = settings.long_item_ground_shipping_price;
    } else {
      priceCents = settings.regular_ground_shipping_price;
    }

    res.json({
      ground: {
        price: priceCents / 100, // dollars — what frontend reads via preview.ground.price
        price_cents: priceCents, // kept for reference
        is_free: isFree,
        is_long: isLong,
      },
      settings,
      cart_total_cents: cartTotalCents,
    });
  } catch (error: any) {
    console.error("Error in /shipping-preview:", error);
    res.status(500).json({
      error: "Failed to calculate shipping preview",
      details: error.message,
    });
  } finally {
    await client.end();
  }
};
