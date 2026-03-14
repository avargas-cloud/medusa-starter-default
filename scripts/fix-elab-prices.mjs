import fs from 'fs';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6InVzZXJfMDFLRkhFV1k5WUZXMUNKNFlUSE1KUDk0NU4iLCJhY3Rvcl90eXBlIjoidXNlciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFLR0o2UlBRRkEyMzVNQkFEWEpXU1RWMFAiLCJhcHBfbWV0YWRhdGEiOnsidXNlcl9pZCI6InVzZXJfMDFLRkhFV1k5WUZXMUNKNFlUSE1KUDk0NU4iLCJyb2xlcyI6W119LCJ1c2VyX21ldGFkYXRhIjp7fSwiaWF0IjoxNzczNDQ0NTMwLCJleHAiOjE3NzM1MzA5MzB9.AS28dJJkiDFMRM15TDdnjBTU1sTuNB-4xh9NGwxpLOI';
const BASE = 'http://localhost:9000';

async function api(path, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts;
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...rest,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(extraHeaders || {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${path}: ${text}`);
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw err;
  }
}

async function main() {
  console.log('Fetching ELAB- products...');
  const data = await api('/admin/products?q=ELAB-&limit=50');
  const products = data.products || [];
  
  console.log(`Found ${products.length} products to check.`);
  
  for (const p of products) {
    if (!p.handle.startsWith('elab-')) continue;
    
    const variantId = p.variants?.[0]?.id;
    if (!variantId) continue;
    
    // Detailed variant fetch
    const vData = await api(`/admin/products/${p.id}/variants/${variantId}?fields=*prices`);
    const prices = vData.variant.prices;
    if (!prices || prices.length === 0) continue;
    
    const price = prices[0];
    const currentPrice = parseFloat(price.amount);
    
    // Only fix if it looks like it was multiplied by 100 (e.g. > 100 for these labor services)
    if (currentPrice > 100) {  
      const correctPrice = currentPrice / 100;
      console.log(`Fixing ${p.title}: ${currentPrice} -> ${correctPrice}`);
      
      try {
        await api(`/admin/products/${p.id}/variants/${variantId}`, {
          method: 'POST',
          body: JSON.stringify({
            prices: [
              {
                id: price.id,
                amount: correctPrice
              }
            ]
          })
        });
        console.log(` ✅ Updated ${p.title}`);
      } catch(e) {
        console.log(` ❌ Failed ${p.title}: `, e.message);
      }
    } else {
      console.log(` - Skipping ${p.title}, price looks okay: ${currentPrice}`);
    }
  }
}

main().catch(console.error);
