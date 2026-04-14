#!/usr/bin/env tsx
import "dotenv/config";
import pg from "pg";
const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const PUBLISHABLE_KEY = process.env.PUBLISHABLE_API_KEY || "";
const TARGET_SKU = "ESPFC4R4N50W0840";

async function verifyNativeCheckout() {
  console.log("\n--- 🛒 CHECKOUT V2 ENDPOINT VERIFICATION ---");

  if (!PUBLISHABLE_KEY) {
    console.error("❌ Error: No PUBLISHABLE_API_KEY found in .env");
    process.exit(1);
  }

  const headers = {
    "Content-Type": "application/json",
    "x-publishable-api-key": PUBLISHABLE_KEY,
  };

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Find the requested product variant
  console.log(`🔍 Locating variant for SKU: ${TARGET_SKU}...`);
  const variantRes = await client.query(
    `
        SELECT v.id 
        FROM product_variant v
        WHERE v.sku = $1 AND v.deleted_at IS NULL
        LIMIT 1
    `,
    [TARGET_SKU]
  );

  if (variantRes.rows.length === 0) {
    console.error(`❌ Could not find variant with SKU: ${TARGET_SKU}`);
    process.exit(1);
  }
  const TEST_VARIANT_ID = variantRes.rows[0].id;
  console.log(`✅ Using variant: ${TEST_VARIANT_ID}`);

  // Find a valid region
  const regionResApi = await fetch(`${MEDUSA_URL}/store/regions`, { headers });
  const { regions } = await regionResApi.json();
  if (!regions || regions.length === 0) {
    console.error("❌ Could not find any regions.");
    process.exit(1);
  }
  const region_id = regions[0].id;

  try {
    console.log(
      `\n📦 1. Creating a Test Cart natively with item ${TEST_VARIANT_ID}...`
    );
    const createCartRes = await fetch(`${MEDUSA_URL}/store/carts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        region_id: region_id,
        items: [{ variant_id: TEST_VARIANT_ID, quantity: 2 }],
      }),
    });

    if (!createCartRes.ok) throw new Error("Failed to create native cart.");
    const { cart } = await createCartRes.json();
    const cartId = cart.id;
    console.log(`✅ Cart created: ${cartId}`);

    console.log(`\n🚚 2. Resolving available Shipping Methods natively...`);
    const optsRes = await fetch(
      `${MEDUSA_URL}/store/shipping-options?cart_id=${cartId}`,
      { headers }
    );
    const optsData = await optsRes.json();
    const options = optsData.shipping_options;
    if (!options || options.length === 0) {
      console.error(`❌ No shipping options available.`);
      process.exit(1);
    }
    const TEST_SHIPPING_OPTION_ID = options[0].id;
    console.log(`✅ Read shipping option to use: ${TEST_SHIPPING_OPTION_ID}`);

    console.log(
      "\n🚀 3. Triggering custom POST /store/checkout-v2 wrapper endpoint..."
    );
    console.log(
      "Sending: { cartId, email, shippingAddress, shippingMethodId, opaqueData }"
    );

    // Pass dummy Authorize.net token logic. We might fail on the auth step but we will see
    // the calculated authoritative total in the logs before that!
    // NOTE: In checkout-v2 the authoritative amount is computed inside the API.
    const checkoutV2Res = await fetch(`${MEDUSA_URL}/store/checkout-v2`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cartId: cartId,
        email: "test@ecopowertech.com",
        shippingAddress: {
          firstName: "Test",
          lastName: "Customer",
          address1: "123 Main St",
          city: "Miami",
          country: "us",
          state: "FL",
          postcode: "33101",
        },
        shippingMethodId: TEST_SHIPPING_OPTION_ID,
        opaqueData: {
          dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT",
          dataValue: "dummy-token-for-test",
        },
      }),
    });

    const resText = await checkoutV2Res.text();
    let completionData;
    try {
      completionData = JSON.parse(resText);
    } catch {}

    if (!checkoutV2Res.ok) {
      console.error(
        `❌ Checkout V2 Failed (${checkoutV2Res.status}):`,
        completionData?.error || resText
      );
      console.log(
        "\n⚠️ Note: Failure is expected if dummy opaqueData is rejected by Authorize.net context."
      );
      process.exit(1);
    }

    console.log(
      `\n🎉 Checkout V2 Success! Order ID: ${completionData.orderId} (Order #${completionData.displayId})`
    );

    console.log(`\n🔍 4. Inspecting Order Output in DB...`);
    console.log(
      `\n--- 📊 DB STATE FOR ORDER ${completionData.orderId} (#${completionData.displayId}) ---`
    );

    const summaryRes = await client.query(
      `SELECT jsonb_pretty(totals) AS totals FROM order_summary WHERE order_id = $1`,
      [completionData.orderId]
    );
    if (summaryRes.rows.length > 0) {
      console.log(`\n📦 Order Summary Totals:\n`, summaryRes.rows[0].totals);
    }

    const itemsRes = await client.query(
      `SELECT * FROM order_item WHERE order_id = $1`,
      [completionData.orderId]
    );
    console.log(`\n📦 Order Items (Final DB State):`);
    let itemIds: string[] = [];
    itemsRes.rows.forEach((r) => {
      itemIds.push(r.item_id);
      console.log(` - Item: ${JSON.stringify(r)}`);
    });

    if (itemIds.length > 0) {
      const lineItemsRes = await client.query(
        `SELECT * FROM order_line_item WHERE id = ANY($1)`,
        [itemIds]
      );
      console.log(`\n📦 Order Line Items (the actual variants):`);
      lineItemsRes.rows.forEach((r) => {
        console.log(` - Line Item: ${JSON.stringify(r)}`);
      });
    }
  } catch (error: any) {
    console.error(`\n❌ Error:`, error.message);
  } finally {
    await client.end();
  }
}

verifyNativeCheckout();
