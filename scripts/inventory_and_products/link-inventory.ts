import { MedusaModule, Modules } from "@medusajs/framework/utils"
import { IInventoryService, IProductModuleService, ILinkModule } from "@medusajs/types"
import { initialize as initProduct } from "@medusajs/product"
import { initialize as initInventory } from "@medusajs/inventory"
import { ContainerRegistrationKeys } from "@medusajs/utils"
import { getModuleDependencies } from "@medusajs/modules-sdk"
// En un script standalone podemos arrancar medusaapp o usar los servicios
import express from "express"
import loaders from "@medusajs/medusa/dist/loaders"

async function run() {
  console.log("Iniciando escaneo de Variantes sin Inventario...")
  const app = express()
  const { container } = await loaders({
    directory: process.cwd(),
    expressApp: app,
    isTest: false,
  })

  // Obtener Remote Query para hacer una búsqueda limpia
  const query = container.resolve("remoteQuery")

  // Obtener los servicios principales para mutar
  const inventoryModuleService: IInventoryService = container.resolve(Modules.INVENTORY)
  const productModuleService: IProductModuleService = container.resolve(Modules.PRODUCT)
  const linkModule: ILinkModule = container.resolve(ContainerRegistrationKeys.LINK)

  // 1. Obtener todas las variantes que manejamos stock (manage_inventory: true)
  // remoteQuery nos permite pedir a la vez la variante y su link de inventario
  const queryRes = await query({
    variants: {
      fields: ["id", "title", "sku", "manage_inventory"],
      inventory_items: {
        fields: ["inventory_item_id"]
      }
    }
  })

  const variants = queryRes || []
  console.log(`\n==========================================`)
  console.log(`🔍 Total de variantes en DB: ${variants.length}`)
  
  // Filtramos: 
  // - manage_inventory: true
  // - NO tienen un link en inventory_items
  const unlinkedVariants = variants.filter(
    (v: any) => v.manage_inventory && (!v.inventory_items || v.inventory_items.length === 0)
  )

  console.log(`⚠️ Variantes SIN Inventory Item vinculado: ${unlinkedVariants.length}`)

  if (unlinkedVariants.length === 0) {
    console.log("✅ Todas las variantes están vinculadas correctamente. Saliendo.")
    process.exit(0)
  }

  // Previsualización (primeros 5)
  console.log("\nEjemplo de SKUs que necesitan arreglo:")
  console.log(unlinkedVariants.slice(0, 5).map((v: any) => v.sku || v.id).join(", "))

  const isDryRun = process.argv.includes("--dry-run")
  
  if (isDryRun) {
    console.log("\n💡 MODO DRY-RUN: No se realizarán cambios. Ejecuta con 'yarn sync:inventory-links --run' para aplicar.")
    process.exit(0)
  }

  if (!process.argv.includes("--run")) {
    console.log("\n💡 Sugerencia: Muestra previa completada. Corre el comando con '--run' para ejecutar.")
    process.exit(0)
  }

  console.log("\n🚀 [MODO RUN] Creando Inventory Items y vinculando...")
  let fixedCount = 0
  let errorCount = 0

  for (const v of unlinkedVariants) {
    try {
      // a) Crear el Item de Inventario en el módulo
      const createdItem = await inventoryModuleService.createInventoryItems({
        sku: v.sku ?? v.id,
        title: v.title ?? v.sku ?? v.id,
        requires_shipping: true
      })

      // b) Crear el Link (ProductVariant <-> InventoryItem)
      // Módulo: "productVariantInventoryItemLink"
      await linkModule.create({
        [Modules.PRODUCT]: { variant_id: v.id },
        [Modules.INVENTORY]: { inventory_item_id: createdItem.id }
      })

      fixedCount++
      if (fixedCount % 100 === 0) {
        console.log(`   Procesadas ${fixedCount} variantes...`)
      }
    } catch (err: any) {
      console.error(`❌ Error arreglando variante ${v.sku || v.id}: ${err.message}`)
      errorCount++
    }
  }

  console.log(`\n🎉 PROCESO COMPLETADO`)
  console.log(`🟩 Creados y vinculados: ${fixedCount}`)
  console.log(`🟥 Errores: ${errorCount}`)

  process.exit(0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
