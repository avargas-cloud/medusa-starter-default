import 'dotenv/config';

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
  const PUBLISHABLE_KEY = process.env.PUBLISHABLE_API_KEY || "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"

  try {
    // 1. Create Cart
    const cartRes = await fetch(`${MEDUSA_URL}/store/carts`, {
      method: 'POST',
      headers: { 
        "x-publishable-api-key": PUBLISHABLE_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: "test.tax.new@example.com",
        sales_channel_id: "sc_01KFH54H94ZZF2A1NBBZ3M6M16",
        region_id: "reg_01KFH54TDXYE5N7WBYE9RXXA8K",
        currency_code: "usd",
        shipping_address: {
           first_name: "Test",
           last_name: "User",
           address_1: "123 Main St",
           city: "Miami",
           country_code: "us",
           province: "FL",
           postal_code: "33101"
        }
      })
    });
    const { cart } = await cartRes.json();
    console.log("Created Cart:", cart.id);

    // 2. Add Item (UL FREECUT COB LED Strip)
    await fetch(`${MEDUSA_URL}/store/carts/${cart.id}/line-items`, {
      method: 'POST',
      headers: { "x-publishable-api-key": PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ variant_id: "variant_01KFRNPMS8H6Q824NX5RDHNEZA", quantity: 1 })
    });

    // 3. Add Shipping Method (Ground Shipping)
    await fetch(`${MEDUSA_URL}/store/carts/${cart.id}/shipping-methods`, {
      method: 'POST',
      headers: { "x-publishable-api-key": PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ option_id: "so_01KH9ZYAPVKXRGFQR9SMF87TX3" })
    });

    // 4. Fetch Cart Taxes
    const resultRes = await fetch(`${MEDUSA_URL}/store/carts/${cart.id}?fields=+shipping_methods.tax_total,+items.tax_total`, {
      headers: { "x-publishable-api-key": PUBLISHABLE_KEY }
    });
    const { cart: finalCart } = await resultRes.json();
    
    console.log("FINAL Cart Tax Total:", finalCart.tax_total);
    console.log("FINAL Cart Shipping Tax:", finalCart.shipping_methods[0]?.tax_total);
    console.log("FINAL Cart Item Tax:", finalCart.items[0]?.tax_total);
    
  } catch (err) {
    console.error(err);
  }
}
run();
