/**
 * create-services-2.mjs
 * Creates 17 labor service products from services 2.ods
 * Category: Labors (pcat_01KKPFS8FD373CX0FE7GQM9XHQ)
 * All have prices in USD cents
 */

import fs from 'fs';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6InVzZXJfMDFLRkhFV1k5WUZXMUNKNFlUSE1KUDk0NU4iLCJhY3Rvcl90eXBlIjoidXNlciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFLR0o2UlBRRkEyMzVNQkFEWEpXU1RWMFAiLCJhcHBfbWV0YWRhdGEiOnsidXNlcl9pZCI6InVzZXJfMDFLRkhFV1k5WUZXMUNKNFlUSE1KUDk0NU4iLCJyb2xlcyI6W119LCJ1c2VyX21ldGFkYXRhIjp7fSwiaWF0IjoxNzczNDQ0NTMwLCJleHAiOjE3NzM1MzA5MzB9.AS28dJJkiDFMRM15TDdnjBTU1sTuNB-4xh9NGwxpLOI'
const BASE = 'http://localhost:9000'
const POS_SC = 'sc_15154EAF0D194265ADD21AAD2D'
const WEB_SC = 'sc_01KFH7QCHT364SX242A69ZR435'
const LABOR_CAT = 'pcat_01KKPFS8FD373CX0FE7GQM9XHQ'
const SERVICE_TYPE = 'ptyp_01KFTQDH0RJRG5CEVMVWMN58PD'

const SERVICES = JSON.parse(fs.readFileSync('/tmp/services2_parsed.json', 'utf8'));

async function api(path, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(extraHeaders || {}) },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(json)}`)
  return json
}

async function main() {
  console.log(`Starting creation of ${SERVICES.length} services...`);
  for (const svc of SERVICES) {
    try {
      console.log(`\n📦 Creating: ${svc.sku}`)
      
      const body = {
        title: svc.sku,
        status: 'draft',
        type_id: SERVICE_TYPE,
        categories: [{ id: LABOR_CAT }],
        metadata: {
          sales_description: svc.description,
          is_service: true,
        },
        options: [{ title: 'Type', values: ['Service'] }],
        variants: [
          {
            title: 'Default',
            sku: svc.sku,
            manage_inventory: false,
            allow_backorder: true,
            prices: [{ currency_code: 'usd', amount: svc.priceUSD * 100 }],
            options: { Type: 'Service' },
            metadata: {
              sales_description: svc.description,
            },
          },
        ],
      }

      const { product } = await api('/admin/products', { method: 'POST', body: JSON.stringify(body) })
      console.log(`  ✅ Created: ${product.title} → id: ${product.id}`)

      // Assign both sales channels
      for (const sc of [POS_SC, WEB_SC]) {
        await api(`/admin/sales-channels/${sc}/products`, {
          method: 'POST',
          body: JSON.stringify({ add: [product.id] }),
        })
      }
      console.log(`  ✅ Sales channels assigned`)

    } catch (err) {
      console.log(`  ❌ Failed ${svc.sku}: ${err.message}`)
    }
  }
  console.log('\n🎉 Done!')
}

main()
