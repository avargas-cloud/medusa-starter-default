import { resolve } from "path";
import { config } from "dotenv";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";

config({ path: resolve(__dirname, "../../../.env") });

const API_URL = "http://127.0.0.1:9000/store";
const PUBLISHABLE_KEY =
  process.env.PUBLISHABLE_API_KEY ||
  "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";
const JWT_SECRET = process.env.JWT_SECRET || "k2nmdEsaqWvfUGcKjTBuCyVYHR675hZg";
const DB_URL =
  process.env.DATABASE_URL;

const headers = (token?: string): Record<string, string> => ({
  "Content-Type": "application/json",
  "x-publishable-api-key": PUBLISHABLE_KEY,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

async function run() {
  const pool = new Pool({
    connectionString: DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    // Get B2B customer
    const custRes = await pool.query(`
            SELECT c.id FROM customer c
            JOIN customer_group_customer cgc ON c.id = cgc.customer_id LIMIT 1
        `);
    const customerId = custRes.rows[0]?.id;
    const token = jwt.sign(
      { actor_id: customerId, actor_type: "customer" },
      JWT_SECRET,
      { expiresIn: "10m" }
    );

    // Get multiple variants from the wholesale price list
    const listRes = await pool.query(
      `SELECT id FROM price_list WHERE title ILIKE '%Wholesale%' LIMIT 1`
    );
    const varRes = await pool.query(
      `
            SELECT DISTINCT pv.id as variant_id, pr.amount as wholesale_price
            FROM product_variant pv JOIN product p ON pv.product_id = p.id
            JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
            JOIN price pr ON pvps.price_set_id = pr.price_set_id
            WHERE pr.price_list_id = $1 AND p.status = 'published'
            LIMIT 5
        `,
      [listRes.rows[0].id]
    );

    const variants = varRes.rows;
    console.log(
      `\n✅ Found ${variants.length} variants with wholesale prices\n`
    );

    // Create guest cart
    const cartRes = await fetch(`${API_URL}/carts`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({}),
    });
    const { cart } = await cartRes.json();
    const cartId = cart.id;
    console.log(`✅ Cart created: ${cartId}`);

    // Add N items as guest
    for (const v of variants) {
      await fetch(`${API_URL}/carts/${cartId}/line-items`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ variant_id: v.variant_id, quantity: 1 }),
      });
    }
    console.log(`✅ ${variants.length} items added as guest (retail prices)`);

    // Link customer
    await fetch(`${API_URL}/carts/${cartId}/customer`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({}),
    });
    console.log(`✅ Customer linked (${customerId})`);

    // TIME THE REPRICE
    const t0 = Date.now();
    const repriceRes = await fetch(`${API_URL}/carts/${cartId}/reprice`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({}),
    });
    const repriceMs = Date.now() - t0;
    const repriceData = await repriceRes.json();

    console.log(`\n⏱  /reprice with ${variants.length} items: ${repriceMs}ms`);
    console.log(
      `   Response: success=${repriceData.success}, updatesApplied=${repriceData.updatesApplied}`
    );

    // Verify prices
    const cartAfter = await fetch(`${API_URL}/carts/${cartId}`, {
      headers: headers(token),
    });
    const { cart: updatedCart } = await cartAfter.json();

    console.log(`\n--- Prices after reprice ---`);
    for (const item of updatedCart.items || []) {
      const expected = variants.find(
        (v: any) => v.variant_id === item.variant_id
      );
      const correct =
        Number(item.unit_price) === Number(expected?.wholesale_price);
      console.log(
        `   ${item.variant_id}: $${item.unit_price} (expected $${expected?.wholesale_price}) ${correct ? "✅" : "❌"} | is_custom_price=${item.is_custom_price}`
      );
    }
  } catch (e: any) {
    console.error("Error:", e.message);
  } finally {
    await pool.end();
  }
}

run();
