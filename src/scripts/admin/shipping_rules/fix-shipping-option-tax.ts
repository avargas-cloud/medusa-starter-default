import 'dotenv/config';

async function run() {
  const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000"
  const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || "test"
  
  try {
     const res = await fetch(`${MEDUSA_URL}/admin/shipping-options`, {
        headers: { "Authorization": `Bearer ${ADMIN_TOKEN}` }
     });
     
     const { shipping_options } = await res.json();
     console.log(`Found ${shipping_options?.length} shipping options`);
     
     for (const option of shipping_options || []) {
        console.log(`Checking ${option.name} (${option.id}). Providers:`, option.provider_id);
        
        // Let's look at its tax rules or related fields
        const detailRes = await fetch(`${MEDUSA_URL}/admin/shipping-options/${option.id}?fields=*prices,*rules,tax_category_id`, {
            headers: { "Authorization": `Bearer ${ADMIN_TOKEN}` }
        });
        const detail = await detailRes.json();
        console.log(`Detail for ${option.name}:`, JSON.stringify(detail, null, 2));
     }
  } catch (err) {
    console.error(err);
  }
}
run();
