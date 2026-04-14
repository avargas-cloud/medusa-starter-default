import { resolve } from "path";
import { config } from "dotenv";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";

config({ path: resolve(__dirname, "../../../.env") });

const API_URL = "http://127.0.0.1:9000/store";
const PUBLISHABLE_KEY =
  process.env.PUBLISHABLE_API_KEY ||
  "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

async function timedFetch(
  label: string,
  url: string,
  options: RequestInit
): Promise<Response> {
  const t0 = Date.now();
  const res = await fetch(url, options);
  console.log(`  ⏱ ${label}: ${Date.now() - t0}ms`);
  return res;
}

async function run() {
  console.log("==========================================");
  console.log("⏱ TIMING TEST: /add-item vs /line-items");
  console.log("==========================================");

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway",
    ssl: { rejectUnauthorized: false },
  });

  const authHeaders = {
    "Content-Type": "application/json",
    "x-publishable-api-key": PUBLISHABLE_KEY,
  };

  try {
    const custRes = await pool.query(
      `SELECT customer.id FROM customer JOIN customer_group_customer ON customer.id = customer_group_customer.customer_id LIMIT 1`
    );
    const customerId = custRes.rows[0]?.id;
    const token = jwt.sign(
      { actor_id: customerId, actor_type: "customer" },
      process.env.JWT_SECRET || "k2nmdEsaqWvfUGcKjTBuCyVYHR675hZg",
      { expiresIn: "10m" }
    );

    const listRes = await pool.query(
      `SELECT id FROM price_list WHERE title ILIKE '%Wholesale%' LIMIT 1`
    );
    const varRes = await pool.query(
      `SELECT pv.id as variant_id FROM product_variant pv JOIN product p ON pv.product_id = p.id JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id JOIN price pr ON pvps.price_set_id = pr.price_set_id WHERE pr.price_list_id = $1 AND p.status = 'published' LIMIT 1`,
      [listRes.rows[0].id]
    );
    const variantId = varRes.rows[0].variant_id;
    const authedHeaders = { ...authHeaders, Authorization: `Bearer ${token}` };

    // --- Test 1: /add-item (custom endpoint) ---
    console.log("\n--- Test 1: /add-item (our custom endpoint) ---");
    const cart1 = await (
      await timedFetch("create cart", `${API_URL}/carts`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      })
    ).json();
    await timedFetch(
      "link customer",
      `${API_URL}/carts/${cart1.cart.id}/customer`,
      { method: "POST", headers: authedHeaders, body: JSON.stringify({}) }
    );
    const add1Res = await timedFetch(
      "POST /add-item",
      `${API_URL}/carts/${cart1.cart.id}/add-item`,
      {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
      }
    );
    if (!add1Res.ok) console.error("add-item failed:", await add1Res.text());

    // --- Test 2: /line-items (native Medusa endpoint) ---
    console.log("\n--- Test 2: /line-items (native Medusa) ---");
    const cart2 = await (
      await timedFetch("create cart", `${API_URL}/carts`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({}),
      })
    ).json();
    await timedFetch(
      "link customer",
      `${API_URL}/carts/${cart2.cart.id}/customer`,
      { method: "POST", headers: authedHeaders, body: JSON.stringify({}) }
    );
    const add2Res = await timedFetch(
      "POST /line-items",
      `${API_URL}/carts/${cart2.cart.id}/line-items`,
      {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
      }
    );
    if (!add2Res.ok) console.error("line-items failed:", await add2Res.text());

    console.log("\n✅ Done. Compare the timings above.");
  } catch (e: any) {
    console.error("Error:", e.message);
  } finally {
    await pool.end();
  }
}

run();
