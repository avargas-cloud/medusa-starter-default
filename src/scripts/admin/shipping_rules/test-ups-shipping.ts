import * as dotenv from "dotenv";
dotenv.config();

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
  const PUBLISHABLE_KEY =
    process.env.PUBLISHABLE_API_KEY ||
    "pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3";

  try {
    const r = await fetch(`${MEDUSA_URL}/store/regions`, {
      headers: { "x-publishable-api-key": PUBLISHABLE_KEY },
    });
    const { regions } = await r.json();
    const regionId = regions?.[0]?.id;

    // 1. Create a cart
    const cartRes = await fetch(`${MEDUSA_URL}/store/carts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        email: "test@example.com",
        currency_code: "usd",
        region_id: regionId,
      }),
    });

    if (!cartRes.ok) {
      console.error("Cart creation failed:", await cartRes.text());
      return;
    }
    const { cart } = await cartRes.json();
    console.log("Cart created:", cart.id);

    // 2. Add shipping address
    await fetch(`${MEDUSA_URL}/store/carts/${cart.id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-api-key": PUBLISHABLE_KEY,
      },
      body: JSON.stringify({
        shipping_address: {
          first_name: "John",
          last_name: "Doe",
          address_1: "123 Main St",
          city: "Miami",
          province: "FL",
          postal_code: "33101",
          country_code: "us",
        },
      }),
    });

    // 3. Request shipping options
    console.log("Fetching shipping options...");
    const optionsRes = await fetch(
      `${MEDUSA_URL}/store/shipping-options?cart_id=${cart.id}`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-publishable-api-key": PUBLISHABLE_KEY,
        },
      }
    );
    const optionsData = await optionsRes.json();

    // 4. Calculate UPS Ground Option if present
    const upsOption = optionsData.shipping_options?.find(
      (o) => o.provider_id === "ups-ground"
    );
    if (upsOption) {
      console.log(
        `Calculating UPS Ground Price... (option id: ${upsOption.id})`
      );
      const calcRes = await fetch(
        `${MEDUSA_URL}/store/shipping-options/${upsOption.id}/calculate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-publishable-api-key": PUBLISHABLE_KEY,
          },
          body: JSON.stringify({ cart_id: cart.id }),
        }
      );
      if (!calcRes.ok)
        console.error("Calculation failed:", await calcRes.text());
      else console.log(await calcRes.json());
    } else {
      console.log("No UPS Ground option found");
    }
  } catch (err) {
    console.error(err);
  }
}
run();
