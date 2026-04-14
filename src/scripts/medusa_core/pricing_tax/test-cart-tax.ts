// @ts-nocheck

import "dotenv/config";

// Bypass localhost SSL issues if any
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
// You must have a valid publishable key. Adjust if needed.
const PUB_KEY =
  process.env.MEDUSA_PUBLISHABLE_KEY ||
  "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

async function storeFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${MEDUSA_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-publishable-api-key": PUB_KEY,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch {
    return { status: res.status, data: text };
  }
}

async function runTaxTest() {
  console.log("🚀 Starting Medusa v2 Tax & Pricing Simulation...");

  // 1. Create a Cart
  console.log("\n[1] Creating Cart...");
  const cartRes = await storeFetch("/store/carts", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (cartRes.status !== 200)
    return console.error("Failed to create cart:", cartRes);
  const cartId = cartRes.data.cart.id;
  console.log(`✅ Cart Created: ${cartId}`);

  // 2. Add the specific variant requested by the user
  console.log(
    "\n[2] Fetching explicit variant: variant_01KFRNPMS8K91A2HQ49W5JRB88..."
  );
  // The user provided this exact ID:
  const variantId = "variant_01KFRNPMS8K91A2HQ49W5JRB88";

  console.log(`Adding Variant ${variantId} to cart (Qty 8)...`);
  const addRes = await storeFetch(`/store/carts/${cartId}/line-items`, {
    method: "POST",
    body: JSON.stringify({ variant_id: variantId, quantity: 8 }),
  });
  if (addRes.status !== 200)
    return console.error("Failed to add item:", addRes);
  console.log(`✅ Item added. Cart Subtotal: $${addRes.data.cart.subtotal}`);

  // 3. Set a Florida Shipping Address
  console.log("\n[3] Setting Shipping Address (Florida)...");
  const addressRes = await storeFetch(`/store/carts/${cartId}`, {
    method: "POST",
    body: JSON.stringify({
      shipping_address: {
        first_name: "Test",
        last_name: "User",
        address_1: "123 Fake St",
        city: "Miami",
        province: "us-fl", // Match DB tax_region.province_code exactly
        country_code: "us",
        postal_code: "33101",
      },
      email: "test@example.com",
    }),
  });
  if (addressRes.status !== 200)
    return console.error("Failed to set address:", addressRes);
  console.log("✅ Address set to Florida.");

  // 4. Fetch Shipping Options
  console.log("\n[4] Fetching Shipping Options...");
  const optsRes = await storeFetch(`/store/shipping-options?cart_id=${cartId}`);
  if (optsRes.status !== 200)
    return console.error("Failed to fetch options:", optsRes);
  const options = optsRes.data.shipping_options;

  if (!options || options.length === 0)
    return console.error("No shipping options available for this address.");
  const optionId = options[0].id;
  console.log(
    `Available Options: ${options.length}. Selecting ${options[0].name} (ID: ${optionId})`
  );

  // 5. Add Shipping Method
  console.log("\n[5] Adding Shipping Method to Cart...");
  const methodRes = await storeFetch(
    `/store/carts/${cartId}/shipping-methods`,
    {
      method: "POST",
      body: JSON.stringify({ option_id: optionId }),
    }
  );
  if (methodRes.status !== 200)
    return console.error("Failed to add shipping method:", methodRes);
  console.log("✅ Shipping Method Added.");

  // 6. Fetch Final Cart to see Taxes and Totals
  console.log("\n[6] Fetching Final Cart Totals...");
  // Let's also hit /shipping-preview to see what Medusa calculates for taxes
  // And directly hit the cart endpoint
  const finalCartRes = await storeFetch(`/store/carts/${cartId}`);
  const cart = finalCartRes.data.cart;

  console.log("\n================ MEDUSA v2 CART SUMMARY ================");
  console.log(`Subtotal:      $${cart.subtotal}`);
  // shipping_total and tax_total in v2 might be cents or dollars depending on endpoint.
  console.log(`Shipping:      ${cart.shipping_total}`);
  console.log(`Tax Total:     ${cart.tax_total}`);
  console.log(`Total:         ${cart.total}`);
  console.log("========================================================");

  if (cart.tax_total === 0 || cart.tax_total === "0") {
    console.log(
      "❌ FAIL: Tax is 0 even with a Florida address. Pre-payment calculation failed."
    );
  } else {
    console.log(
      "✅ SUCCESS: Tax was successfully calculated by Medusa pre-payment!"
    );
  }

  // 7. Complete Cart to check for Tax Drop
  console.log("\n[7] Simulating Payment Session & Order Completion...");
  const collectionRes = await storeFetch(`/store/payment-collections`, {
    method: "POST",
    body: JSON.stringify({ cart_id: cartId }),
  });
  if (
    collectionRes.status === 200 &&
    collectionRes.data?.payment_collection?.id
  ) {
    const collectionId = collectionRes.data.payment_collection.id;
    console.log(`✅ Collection created: ${collectionId}`);

    const sessionRes = await storeFetch(
      `/store/payment-collections/${collectionId}/payment-sessions`,
      {
        method: "POST",
        body: JSON.stringify({
          provider_id: "pp_system_default",
          data: {},
        }),
      }
    );

    if (sessionRes.status === 200) {
      console.log("✅ Payment Session active. Completing cart...");
      const completeRes = await storeFetch(`/store/carts/${cartId}/complete`, {
        method: "POST",
      });

      if (completeRes.status === 200) {
        const order = completeRes.data.order;
        console.log("\n================ ORDER SUMMARY ================");
        console.log(`Order Tax Total: ${order.tax_total}`);
        if (order.tax_total === 0 || order.tax_total === "0") {
          console.log(
            "❌ CRITICAL FAIL: Tax dropped to 0 DURING order completion!"
          );
        } else {
          console.log(
            "✅ SUCCESS: Tax successfully carried over to final order!"
          );
        }
      } else {
        console.error("Failed to complete cart:", completeRes.data);
      }
    }
  }
}

runTaxTest();
