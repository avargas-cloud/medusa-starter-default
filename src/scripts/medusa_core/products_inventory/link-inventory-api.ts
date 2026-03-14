import { config } from "dotenv"
import { resolve } from "path"
import fs from "fs"

const envFile = fs.readFileSync(resolve(process.cwd(), ".env"), "utf-8")
const tokenMatch = envFile.match(/ADMIN_API_TOKEN=(.+)/)
const TOKEN = tokenMatch ? tokenMatch[1].trim() : ""

const BASE_URL = "http://localhost:9000/admin"

if (!TOKEN) {
  console.error("❌ No ADMIN_API_TOKEN found in .env string extraction")
  process.exit(1)
}

const headers = {
  "Authorization": `Bearer ${TOKEN}`,
  "Content-Type": "application/json"
}

async function api(path: string, method = "GET", body?: any) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`API Error: ${res.status} - ${err}`)
  }
  return res.json()
}

async function run() {
  console.log("🔍 Scanning for variants without inventory links via Medusa API...")
  
  // NOTE: Medusa default limit is 50. Let's get up to 5000 records
  const data = await api("/variants?limit=5000&fields=*inventory_items")
  const variants = data.variants || []
  
  console.log(`\n📦 Total variants found: ${variants.length}`)
  
  const toFix = variants.filter((v: any) => 
    v.manage_inventory === true && 
    (!v.inventory_items || v.inventory_items.length === 0)
  )
  
  console.log(`⚠️ Variants requiring a missing Inventory Item: ${toFix.length}`)
  
  if (toFix.length === 0) {
    console.log("✅ All managed variants have an inventory item. Exiting.")
    process.exit(0)
  }
  
  console.log("\nEjemplo de SKUs que necesitan arreglo:")
  console.log(toFix.slice(0, 10).map((v: any) => v.sku || v.id).join(", "))
  
  if (!process.argv.includes("--run")) {
    console.log("\n💡 MODO DRY-RUN: Run this script with '--run' to actually apply fixes.")
    process.exit(0)
  }

  console.log("\n🚀 Creating Inventory Items and Links...")
  let fixedCount = 0
  let errorCount = 0

  for (const v of toFix) {
    try {
      const reqBody = {
        sku: v.sku || v.id,
        title: v.title || v.sku || v.id,
        requires_shipping: true,
        // Optional weight/dimensions if present
        weight: v.weight || null,
        length: v.length || null,
        height: v.height || null,
        width: v.width || null,
        hs_code: v.hs_code || null,
        origin_country: v.origin_country || null,
        mid_code: v.mid_code || null,
        material: v.material || null, 
      }
      const invRes = await api("/inventory-items", "POST", reqBody)
      const invItemId = invRes.inventory_item.id

      await api(`/variants/${v.id}/inventory`, "POST", {
        inventory_items: [{
           inventory_item_id: invItemId,
           required_quantity: 1
        }]
      })

      fixedCount++
      if (fixedCount % 10 === 0) console.log(`   Procesados: ${fixedCount}...`)
    } catch(e: any) {
      console.error(`❌ Fallo en variante ${v.sku || v.id}: ${e.message}`)
      errorCount++
    }
  }

  console.log(`\n🎉 PROCESO COMPLETADO`)
  console.log(`🟩 Arreglados: ${fixedCount}`)
  console.log(`🟥 Errores: ${errorCount}`)
  
}

run()
