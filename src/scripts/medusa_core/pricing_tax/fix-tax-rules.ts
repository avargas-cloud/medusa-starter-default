import "dotenv/config";

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
  const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || "test";

  try {
    // 1. Get the tax rate (Florida)
    const res = await fetch(`${MEDUSA_URL}/admin/tax-rates?q=Florida`, {
      method: "GET",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const data = await res.json();
    console.log("Tax Rates:", data);

    if (data.tax_rates?.length > 0) {
      const flTax = data.tax_rates[0];
      console.log(
        `Adding rule to ${flTax.name} (${flTax.id}) to only apply to products`
      );

      // 2. Add rule: reference = "product" (meaning it only applies to products, not shipping_options)
      const ruleRes = await fetch(
        `${MEDUSA_URL}/admin/tax-rates/${flTax.id}/rules`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            reference: "product",
            reference_id: "ALL", // or any valid string if required, usually omitting reference_id applies to all products
          }),
        }
      );
      console.log("Rule Creation Result:", await ruleRes.json());
    }
  } catch (err) {
    console.error(err);
  }
}

run();
