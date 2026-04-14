import { resolve } from "path";
import { config } from "dotenv";
import * as jwt from "jsonwebtoken";
import { Pool } from "pg";

config({ path: resolve(__dirname, "../../../.env") });

const API_URL = "http://127.0.0.1:9000/store";
const PUBLISHABLE_KEY =
  process.env.PUBLISHABLE_API_KEY ||
  "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

async function getCartItems(cartId: string, token?: string) {
  const res = await fetch(`${API_URL}/carts/${cartId}`, {
    headers: {
      "x-publishable-api-key": PUBLISHABLE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const data = await res.json();
  return data.cart?.items || [];
}

async function run() {
  console.log("==========================================");
  console.log("🧪 TEST: reprice endpoint refactor");
  console.log("  (cart: add item as guest → link customer → reprice)");
  console.log("==========================================");

  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway",
    ssl: { rejectUnauthorized: false },
  });

  try {
    // --- Find B2B customer and wholesale variant ---
    const custRes = await pool.query(`
            SELECT customer.id FROM customer 
            JOIN customer_group_customer ON customer.id = customer_group_customer.customer_id LIMIT 1
        `);
    const customerId = custRes.rows[0]?.id;
    if (!customerId) throw new Error("No B2B customer found");

    const jwt_secret =
      process.env.JWT_SECRET || "k2nmdEsaqWvfUGcKjTBuCyVYHR675hZg";
    const token = jwt.sign(
      { actor_id: customerId, actor_type: "customer" },
      jwt_secret,
      { expiresIn: "10m" }
    );

    const listRes = await pool.query(
      `SELECT id FROM price_list WHERE title ILIKE '%Wholesale%' LIMIT 1`
    );
    const varRes = await pool.query(
      `
            SELECT pv.id as variant_id, pr.amount as wholesale_price
            FROM product_variant pv JOIN product p ON pv.product_id = p.id
            JOIN product_variant_price_set pvps ON pv.id = pvps.variant_id
            JOIN price pr ON pvps.price_set_id = pr.price_set_id
            WHERE pr.price_list_id = $1 AND p.status = 'published' LIMIT 1
        `,
      [listRes.rows[0].id]
    );
    const { variant_id, wholesale_price } = varRes.rows[0];
    console.log(
      `✅ Variant: ${variant_id} | Expected wholesale: $${wholesale_price}`
    );

    // --- Step 1: Create cart WITHOUT linking customer (retail context) ---
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
    console.log(`✅ Cart created (no customer): ${cartId}`);

    // --- Step 2: Add item as guest (should get retail price) ---
    const nativeAddRes = await fetch(`${API_URL}/carts/${cartId}/line-items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({ variant_id, quantity: 1 }),
    });
    if (!nativeAddRes.ok)
      throw new Error(
        "Guest add failed: " + JSON.stringify(await nativeAddRes.json())
      );
    console.log(`✅ Item added as guest`);

    const guestItems = await getCartItems(cartId);
    const guestItem = guestItems[0];
    console.log(`\n📋 BEFORE reprice (retail/guest):`);
    console.log(`   unit_price:          $${guestItem?.unit_price}`);
    console.log(`   compare_at:          $${guestItem?.compare_at_unit_price}`);
    console.log(`   is_custom_price:     ${guestItem?.is_custom_price}`);

    // --- Step 3: Link customer ---
    await fetch(`${API_URL}/carts/${cartId}/customer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({}),
    });
    console.log(`\n✅ Customer linked (${customerId})`);

    // --- Step 4: Call /reprice ---
    const repriceRes = await fetch(`${API_URL}/carts/${cartId}/reprice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({}),
    });
    const repriceData = await repriceRes.json();
    if (!repriceRes.ok)
      throw new Error("Reprice failed: " + JSON.stringify(repriceData));
    console.log(`✅ /reprice responded: success=${repriceData.success}`);

    // --- Step 5: Fetch updated cart and check ---
    const finalItems = await getCartItems(cartId, token);
    const finalItem = finalItems[0];

    console.log(`\n📋 AFTER reprice (wholesale):`);
    console.log(`   unit_price:          $${finalItem?.unit_price}`);
    console.log(`   compare_at:          $${finalItem?.compare_at_unit_price}`);
    console.log(`   is_custom_price:     ${finalItem?.is_custom_price}`);

    console.log(`\n--- VERDICT ---`);
    if (
      Number(finalItem?.unit_price) === Number(wholesale_price) &&
      !finalItem?.is_custom_price
    ) {
      console.log(
        `🎉 PASS: reprice works natively! Wholesale price applied, is_custom_price=false!`
      );
    } else if (finalItem?.unit_price === guestItem?.unit_price) {
      console.log(
        `⚠️  Price unchanged after reprice. updateCartWorkflow may not trigger repricing.`
      );
      console.log(`   This means we may need a different approach.`);
    } else {
      console.log(
        `❌ FAIL: unexpected result. is_custom_price=${finalItem?.is_custom_price}, price=${finalItem?.unit_price}`
      );
    }
  } catch (e: any) {
    console.error("Test Error:", e.message || e);
  } finally {
    await pool.end();
  }
}

run();
