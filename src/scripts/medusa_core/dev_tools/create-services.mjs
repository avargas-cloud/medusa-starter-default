/**
 * create-services.mjs
 * Creates 5 non-taxable service products in Medusa Admin API
 * Run: node scripts/create-services.mjs
 */

const BASE = 'http://localhost:9000'
const EMAIL = 'a.vargas@ecopowertech.com'
const PASSWORD = 'Test1234!'

const POS_SC_ID    = 'sc_15154EAF0D194265ADD21AAD2D'
const WEB_SC_ID    = 'sc_01KFH7QCHT364SX242A69ZR435'

const SERVICES = [
  {
    sku: 'Assembly-Panels',
    description: '',
  },
  {
    sku: 'Expedite-Assembly',
    description: 'This fee covers the expedited assembly of products, ensuring faster completion and delivery, including the possibility of same-day service. Availability is subject to the current volume of work and project scope.',
  },
  {
    sku: 'Installation-On-Site',
    description: '',
  },
  {
    sku: 'On-Site-Assestment',
    description: '',
  },
  {
    sku: 'Service-Photometric',
    description: '',
  },
]

async function api(path, opts = {}) {
  const { headers: extraHeaders, ...rest } = opts
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(json)}`)
  return json
}

async function main() {
  // Use extracted token directly (from browser session)
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY3Rvcl9pZCI6InVzZXJfMDFLRkhFV1k5WUZXMUNKNFlUSE1KUDk0NU4iLCJhY3Rvcl90eXBlIjoidXNlciIsImF1dGhfaWRlbnRpdHlfaWQiOiJhdXRoaWRfMDFLR0o2UlBRRkEyMzVNQkFEWEpXU1RWMFAiLCJhcHBfbWV0YWRhdGEiOnsidXNlcl9pZCI6InVzZXJfMDFLRkhFV1k5WUZXMUNKNFlUSE1KUDk0NU4iLCJyb2xlcyI6W119LCJ1c2VyX21ldGFkYXRhIjp7fSwiaWF0IjoxNzczNDQ0NTMwLCJleHAiOjE3NzM1MzA5MzB9.AS28dJJkiDFMRM15TDdnjBTU1sTuNB-4xh9NGwxpLOI'
  console.log('✅ Using extracted auth token')

  const H = { Authorization: `Bearer ${token}` }

  // 2. Find or create "Service" product type
  console.log('🔍 Looking for "Service" product type...')
  const typesRes = await api('/admin/product-types?q=Service&limit=20', { headers: H })
  let typeId = typesRes.product_types?.find(t => t.value === 'Service')?.id

  if (!typeId) {
    console.log('➕ Creating "Service" product type...')
    const newType = await api('/admin/product-types', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ value: 'Service' }),
    })
    typeId = newType.product_type?.id
    console.log(`✅ Created product type: ${typeId}`)
  } else {
    console.log(`✅ Found product type: ${typeId}`)
  }

  // 3. Find the services category
  console.log('🔍 Looking for services category...')
  const catsRes = await api('/admin/product-categories?q=services&limit=20', { headers: H })
  const cat = catsRes.product_categories?.find(c =>
    c.handle === 'services' || c.handle?.includes('service')
  )
  const categoryId = cat?.id
  if (categoryId) {
    console.log(`✅ Found category: ${cat.name} (${categoryId})`)
  } else {
    console.log('⚠️  No services category found — will create products without category')
  }

  // 4. Create each service product
  for (const svc of SERVICES) {
    console.log(`\n📦 Creating: ${svc.sku}`)
    try {
      const body = {
        title: svc.sku,
        handle: svc.sku.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        status: 'published',
        type_id: typeId,
        ...(categoryId ? { categories: [{ id: categoryId }] } : {}),
        metadata: {
          sales_description: svc.description || svc.sku,
          is_service: true,
        },
        options: [{ title: 'Type', values: ['Service'] }],
        variants: [
          {
            title: 'Default',
            sku: svc.sku,
            manage_inventory: false,
            allow_backorder: true,
            prices: [],
            options: { Type: 'Service' },
            metadata: {
              sales_description: svc.description || svc.sku,
            },
          },
        ],
      }

      const res = await api('/admin/products', {
        method: 'POST',
        headers: H,
        body: JSON.stringify(body),
      })
      const productId = res.product?.id
      console.log(`✅ Created: ${svc.sku} → id: ${productId}`)

      // Assign both sales channels post-creation
      if (productId) {
        await api(`/admin/products/${productId}/sales-channels`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify({ add: [POS_SC_ID, WEB_SC_ID] }),
        })
        console.log(`   ✅ Sales channels assigned`)
      }
    } catch (e) {
      console.error(`❌ Failed ${svc.sku}: ${e.message}`)
    }
  }

  console.log('\n🎉 Done!')
}

main().catch(console.error)
