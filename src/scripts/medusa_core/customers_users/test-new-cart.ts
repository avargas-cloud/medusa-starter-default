import "dotenv/config";

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
  const pubKey =
    process.env.PUBLISHABLE_API_KEY ||
    "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

  try {
    // 1. Create a brand new cart with FL address
    const cartRes = await fetch(`${MEDUSA_URL}/store/carts`, {
      method: "POST",
      headers: {
        "x-publishable-api-key": pubKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "test.new.cart@example.com",
        region_id: "reg_01KFH54TDXYE5N7WBYE9RXXA8K",
        sales_channel_id: "sc_01KFH54H94ZZF2A1NBBZ3M6M16",
        shipping_address: {
          first_name: "Test",
          last_name: "User",
          address_1: "123 Main St",
          city: "Miami",
          country_code: "us",
          province: "FL",
          postal_code: "33101",
        },
      }),
    });
    const { cart } = await cartRes.json();
    if (!cart) {
      console.error("Cart creation failed");
      return;
    }
    console.log("Created Cart:", cart.id);

    // 2. Add a line item
    await fetch(`${MEDUSA_URL}/store/carts/${cart.id}/line-items`, {
      method: "POST",
      headers: {
        "x-publishable-api-key": pubKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        variant_id: "variant_01KFRNPMS8H6Q824NX5RDHNEZA",
        quantity: 1,
      }),
    });

    // 3. Add Ground Shipping
    await fetch(`${MEDUSA_URL}/store/carts/${cart.id}/shipping-methods`, {
      method: "POST",
      headers: {
        "x-publishable-api-key": pubKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ option_id: "so_01KH9ZYAPVKXRGFQR9SMF87TX3" }),
    });

    // 4. Retrieve and check totals
    const res = await fetch(`${MEDUSA_URL}/store/carts/${cart.id}`, {
      headers: { "x-publishable-api-key": pubKey },
    });
    const { cart: finalCart } = await res.json();

    console.log("\n--- Tax Results ---");
    console.log("item_subtotal:", finalCart.item_subtotal);
    console.log("shipping_total:", finalCart.shipping_total);
    console.log("tax_total:", finalCart.tax_total);
    console.log("total:", finalCart.total);
    console.log(
      "\nExpected tax_total = item_subtotal * 0.07 =",
      (finalCart.item_subtotal * 0.07).toFixed(4)
    );
    console.log("shipping SHOULD be $0 tax");
  } catch (err) {
    console.error(err);
  }
}
run();
