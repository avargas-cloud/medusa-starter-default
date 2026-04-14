import "dotenv/config";
import { initialize } from "@medusajs/utils";
import { updateCartWorkflow } from "@medusajs/medusa/core-flows";

async function run() {
  const { container } = await initialize({
    configModule: require("../../../medusa-config").default,
  });

  // Try to force a re-calculation on the cart
  const cartId = "cart_01KK1TMASVPMNMPNDKZFMXJ6WM";

  try {
    const pubKey =
      process.env.PUBLISHABLE_API_KEY ||
      "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";
    const MEDUSA_URL =
      process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";

    // 1. Force recalculate by updating email using Store API
    await fetch(`${MEDUSA_URL}/store/carts/${cartId}`, {
      method: "POST",
      headers: {
        "x-publishable-api-key": pubKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "force_recalc_test@example.com" }),
    });

    // 2. Fetch taxes directly
    await fetch(`${MEDUSA_URL}/store/carts/${cartId}/taxes`, {
      method: "POST",
      headers: { "x-publishable-api-key": pubKey },
    });

    const res = await fetch(
      `${MEDUSA_URL}/store/carts/${cartId}?fields=*items,*shipping_methods,shipping_methods.tax_lines,items.tax_lines`,
      {
        headers: { "x-publishable-api-key": pubKey },
      }
    );

    const { cart } = await res.json();
    console.log("Cart Tax:", cart.tax_total);
    console.log("Cart Total:", cart.total);

    console.log("--- Items ---");
    cart.items?.forEach((i: any) => console.log(i.title, "Tax:", i.tax_total));

    console.log("--- Shipping Methods ---");
    cart.shipping_methods?.forEach((sm: any) =>
      console.log(sm.name, "Tax:", sm.tax_total, sm.tax_lines)
    );
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}

run();
