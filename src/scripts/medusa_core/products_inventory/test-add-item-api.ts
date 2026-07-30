import { resolve } from "path";
import { config } from "dotenv";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";

config({ path: resolve(__dirname, "../../../.env") });

const API_URL = "http://127.0.0.1:9000/store";
const PUBLISHABLE_KEY =
  process.env.PUBLISHABLE_API_KEY ||
  "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

async function run() {
  console.log("==========================================");
  console.log("🧪 API LEVEL: NATIVE PRICING VERIFICATION");
  console.log("  (Step 1: add-item cleanup)");
  console.log("==========================================");

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // --- Find a B2B customer ---
    const res = await pool.query(`
            SELECT customer.id 
            FROM customer 
            JOIN customer_group_customer ON customer.id = customer_group_customer.customer_id
            LIMIT 1
        `);
    if (!res.rows[0]) throw new Error("No B2B Customer found");
    const customerId = res.rows[0].id;
    console.log(`✅ B2B Customer ID: ${customerId}`);

    // --- Generate JWT ---
    const JWT_SECRET =
      process.env.JWT_SECRET || "k2nmdEsaqWvfUGcKjTBuCyVYHR675hZg";
    const token = jwt.sign(
      { actor_id: customerId, actor_type: "customer" },
      JWT_SECRET,
      { expiresIn: "10m" }
    );

    // --- Find a published variant with a wholesale price ---
    const listRes = await pool.query(
      `SELECT id FROM price_list WHERE title ILIKE '%Wholesale%' LIMIT 1`
    );
    const varRes = await pool.query(
      `
            SELECT pv.id as variant_id, pr.amount as wholesale_price
            FROM product_variant pv
            JOIN product p ON pv.product_id = p.id
            JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
            JOIN price pr ON pvps.price_set_id = pr.price_set_id
            WHERE pr.price_list_id = $1 AND p.status = 'published'
            LIMIT 1
        `,
      [listRes.rows[0].id]
    );
    const { variant_id, wholesale_price } = varRes.rows[0];
    console.log(
      `✅ Test Variant: ${variant_id}, expected wholesale: $${wholesale_price}`
    );

    // --- Create cart ---
    const cartRes = await fetch(`${API_URL}/carts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({}),
    });
    const { cart } = await cartRes.json();
    const cartId = cart.id;
    console.log(`✅ Cart created: ${cartId}`);

    // --- Link customer BEFORE adding item (critical for native pricing) ---
    const syncRes = await fetch(`${API_URL}/carts/${cartId}/customer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({}),
    });
    const syncData = await syncRes.json();
    console.log(
      `✅ Customer linked to cart. customer_id = ${syncData.cart?.customer_id}`
    );

    // --- Add item via our cleaned up endpoint ---
    const addRes = await fetch(`${API_URL}/carts/${cartId}/add-item`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({ variant_id, quantity: 1 }),
    });
    if (!addRes.ok) {
      const err = await addRes.json();
      throw new Error("add-item failed: " + JSON.stringify(err));
    }
    console.log(`✅ Item added via /add-item`);

    // --- Fetch cart via Store API to get calculated totals ---
    const cartFetchRes = await fetch(`${API_URL}/carts/${cartId}`, {
      headers: {
        "x-publishable-api-key": PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    const fetchedData = await cartFetchRes.json();
    const items = fetchedData.cart?.items || [];
    console.log(`\nCart has ${items.length} item(s)`);

    const item = items[0];
    if (item) {
      console.log(`\n--- ITEM RESULT ---`);
      console.log(`variant_id:             ${item.variant_id}`);
      console.log(`unit_price:             $${item.unit_price}`);
      console.log(`compare_at_unit_price:  $${item.compare_at_unit_price}`);
      console.log(`is_custom_price:        ${item.is_custom_price}`);
      console.log(`\n--- VERDICT ---`);

      if (
        Number(item.unit_price) === Number(wholesale_price) &&
        !item.is_custom_price
      ) {
        console.log(
          `🎉 PASS: Wholesale price applied natively! is_custom_price=false!`
        );
        console.log(`   The Admin order list will now show correct totals.`);
      } else if (!item.is_custom_price) {
        console.log(
          `⚠️  is_custom_price=false (good!) but price $${item.unit_price} ≠ expected wholesale $${wholesale_price}`
        );
        console.log(
          `   Check if Price List rule targets the correct customer group.`
        );
      } else {
        console.log(
          `❌ FAIL: is_custom_price=${item.is_custom_price} — something is still forcing the price.`
        );
      }
    } else {
      console.log(
        `❌ No items found in cart. Raw response:`,
        JSON.stringify(fetchedData, null, 2).slice(0, 500)
      );
    }
  } catch (e: any) {
    console.error("Test Error:", e.message || e);
  } finally {
    await pool.end();
  }
}

run();
