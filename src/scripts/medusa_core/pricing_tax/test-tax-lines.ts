import "dotenv/config";

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
  let cartId = "cart_01KK1TMASVPMNMPNDKZFMXJ6WM";

  try {
    const pubKey =
      process.env.PUBLISHABLE_API_KEY ||
      "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

    const res = await fetch(
      `${MEDUSA_URL}/store/carts/${cartId}?fields=*shipping_methods,shipping_methods.tax_lines,*items,items.tax_lines`,
      {
        headers: { "x-publishable-api-key": pubKey },
      }
    );
    const { cart } = await res.json();
    console.log(JSON.stringify(cart, null, 2));
  } catch (err) {
    console.error(err);
  }
}

run();
