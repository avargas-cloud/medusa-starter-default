import 'dotenv/config';

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
  
  try {
    const res = await fetch(`${MEDUSA_URL}/admin/shipping-options?fields=id,name,is_tax_inclusive,amount,price_type,provider_id,tax_total,tax_lines`, {
      method: 'GET',
      headers: {
        "Authorization": `Bearer ${process.env.ADMIN_API_TOKEN || "test"}`
      }
    });
    
    // Test the specific cart the user used to see its tax lines
    const cartRes = await fetch(`${MEDUSA_URL}/admin/carts/cart_01KK1TMASVPMNMPNDKZFMXJ6WM?fields=id,tax_total,shipping_total,shipping_methods.tax_total,shipping_methods.tax_lines`, {
       method: 'GET',
       headers: { "Authorization": `Bearer ${process.env.ADMIN_API_TOKEN || "test"}` }
    })
    console.log(await cartRes.json());
  } catch (err) {
    console.error(err);
  }
}

run();
