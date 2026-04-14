import "dotenv/config";

const MEDUSA_URL = "http://[::1]:9000";
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

async function debugTaxDrop() {
  console.log("🕵️ Starting Tax Drop Debugger...");

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

  // 2. Add an item (we'll fetch the specific user SKU)
  const SKU = "ESPFC4R4N50W0830";
  console.log(`\n[2] Finding Variant by SKU: ${SKU}...`);

  // Quick variant lookup via products list, we'll try to get it by general search
  const prodRes = await storeFetch(`/store/variants?sku=${SKU}`);
  // If exact SKU search fails on Store API, just grab a random variant but hardcode a massive quantity
  let variantId = prodRes.data?.variants?.[0]?.id;

  if (!variantId) {
    console.warn(
      `Could not find a variant via sku=${SKU}. Falling back to random...`
    );
    const fallbackRes = await storeFetch("/store/products?limit=1");
    variantId = fallbackRes.data?.products?.[0]?.variants?.[0]?.id;
  }

  if (!variantId) {
    console.error("Critical: No variant found to add to cart.", prodRes.data);
    return;
  }

  console.log(`\n[2.5] Adding Variant ${variantId} to cart (Qty: 8)...`);
  const addRes = await storeFetch(`/store/carts/${cartId}/line-items`, {
    method: "POST",
    body: JSON.stringify({ variant_id: variantId, quantity: 8 }),
  });
  if (addRes.status !== 200) return console.error("Failed to add item");

  // 3. Set a Florida Shipping Address (Exactly as the frontend does)
  console.log("\n[3] Setting Shipping Address (Florida)...");
  const addressRes = await storeFetch(`/store/carts/${cartId}`, {
    method: "POST",
    body: JSON.stringify({
      email: "test@example.com",
      shipping_address: {
        first_name: "Test",
        last_name: "User",
        address_1: "123 Fake St",
        city: "Miami",
        province: "Florida", // We force the full name
        country_code: "us",
        postal_code: "33101",
      },
    }),
  });
  if (addressRes.status !== 200) return console.error("Failed to set address");

  // Check if Medusa recorded the address and what the cart total says right now
  console.log("-> Medusa Cart State After Address Update:");
  console.log(
    `   Province saved: ${addressRes.data.cart.shipping_address?.province}`
  );
  console.log(`   Tax Total: ${addressRes.data.cart.tax_total}`);

  // 4. Fetch and add shipping
  const optsRes = await storeFetch(`/store/shipping-options?cart_id=${cartId}`);
  const options = optsRes.data.shipping_options;
  const optionId = options[0].id;

  console.log(`\n[4] Adding Shipping Method ${optionId}...`);
  const methodRes = await storeFetch(
    `/store/carts/${cartId}/shipping-methods`,
    {
      method: "POST",
      body: JSON.stringify({ option_id: optionId }),
    }
  );
  if (methodRes.status !== 200)
    return console.error("Failed to add shipping method");

  console.log("-> Medusa Cart State After Shipping Method:");
  console.log(`   Tax Total: ${methodRes.data.cart.tax_total}`);

  // 5. Force the calculation endpoint to see if it fixes taxes
  console.log(`\n[5] Calculating Cart manually via API... (if available)`);
  const calcRes = await storeFetch(`/store/carts/${cartId}/calculate`, {
    method: "POST",
  });
  // This endpoint might not exist natively in Store API without a plugin, let's see what happens
  if (calcRes.status === 200) {
    console.log(`   Tax Total After Calc: ${calcRes.data.cart.tax_total}`);
  } else {
    console.log(
      `   /calculate returned ${calcRes.status} (Not supported or failed)`
    );
  }

  // 6. Complete cart to see if tax drops on completion
  console.log(
    "\n[6] Preparing Payment Session (Simulating initiate-payment)..."
  );

  const collectionRes = await storeFetch(`/store/payment-collections`, {
    method: "POST",
    body: JSON.stringify({ cart_id: cartId }),
  });
  const collectionId = collectionRes.data?.payment_collection?.id;

  if (collectionId) {
    console.log(`✅ Collection created: ${collectionId}`);
    const sessionRes = await storeFetch(
      `/store/payment-collections/${collectionId}/payment-sessions`,
      {
        method: "POST",
        body: JSON.stringify({
          provider_id: "pp_system_default", // use system payment for quick debug
          data: {},
        }),
      }
    );

    if (sessionRes.status === 200) {
      console.log(`✅ Payment Session initialized`);

      // Check final cart stats before completion
      const preCompleteRes = await storeFetch(`/store/carts/${cartId}`);
      console.log("-> Medusa Cart State RIGHT BEFORE completion:");
      console.log(
        `   Shipping Method: ${preCompleteRes.data.cart.shipping_methods?.[0]?.name}`
      );
      console.log(`   Subtotal: ${preCompleteRes.data.cart.subtotal}`);
      console.log(`   Tax Total: ${preCompleteRes.data.cart.tax_total}`);

      if (
        preCompleteRes.data.cart.tax_total === 0 ||
        preCompleteRes.data.cart.tax_total === "0"
      ) {
        console.log(
          "❌ FAIL: Tax dropped BEFORE completion. Something wiped the tax or shipping address!"
        );
        return;
      }

      // Now complete it
      console.log("\n[7] Completing Cart...");
      const completeRes = await storeFetch(`/store/carts/${cartId}/complete`, {
        method: "POST",
      });

      if (completeRes.status === 200) {
        const finalOrder = completeRes.data.order;
        console.log("-> Order Created:");
        console.log(`   Order Tax Total: ${finalOrder.tax_total}`);

        if (finalOrder.tax_total === 0 || finalOrder.tax_total === "0") {
          console.log(
            "❌ FAIL: Tax dropped DURING completion. The tax calculation module is failing to persist to the order."
          );
        } else {
          console.log("✅ SUCCESS: Tax persisted to the order in simulation.");
        }
      } else {
        console.log(`Failed to complete cart: `, completeRes.data);
      }
    } else {
      console.log(`Failed to init session: `, sessionRes.data);
    }
  } else {
    console.log(`Failed to create collection: `, collectionRes.data);
  }
}

debugTaxDrop();
