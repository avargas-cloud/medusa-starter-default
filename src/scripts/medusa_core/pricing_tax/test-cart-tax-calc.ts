import "dotenv/config";

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
  let cartId = "cart_01KK1TMASVPMNMPNDKZFMXJ6WM";

  try {
    const pubKey =
      process.env.PUBLISHABLE_API_KEY ||
      "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

    // Trigger recalculation by adding/removing a dummy email or something innocuous
    await fetch(`${MEDUSA_URL}/store/carts/${cartId}`, {
      method: "POST",
      headers: {
        "x-publishable-api-key": pubKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "test_tax_recalc@example.com",
      }),
    });

    const res = await fetch(`${MEDUSA_URL}/store/carts/${cartId}`, {
      headers: { "x-publishable-api-key": pubKey },
    });
    const { cart } = await res.json();
    console.log("Cart Tax Total:", cart.tax_total);
    console.log("Cart Total:", cart.total);
    console.log("Cart Shipping Total:", cart.shipping_total);
    console.log("--- Items ---");
    cart.items?.forEach((i: any) => console.log(i.title, "Tax:", i.tax_total));
    console.log("--- Shipping Methods ---");
    cart.shipping_methods?.forEach((sm: any) =>
      console.log(sm.name, "Tax:", sm.tax_total)
    );
  } catch (err) {
    console.error(err);
  }
}

run();
