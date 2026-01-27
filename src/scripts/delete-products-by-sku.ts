import { ExecArgs } from "@medusajs/framework/types"
import { Pool } from "pg"

/**
 * Script de Eliminación Masiva de Productos por SKU
 * 
 * Este script elimina productos completos (con variantes, inventario, precios)
 * usando el patrón DBM (Direct Database Migration) con transacciones SQL.
 * 
 * MODO DRY-RUN (Por defecto):
 *   DRY_RUN=true npx medusa exec ./src/scripts/delete-products-by-sku.ts
 * 
 * MODO EJECUCIÓN REAL:
 *   DRY_RUN=false npx medusa exec ./src/scripts/delete-products-by-sku.ts
 */

const SKUS_TO_DELETE = [
    "ASP-17002A",
    "BL-R4-G19AT",
    "BL-R4-G19RAT",
    "BL-R4-G19SRAT",
    "EAP-RM2-EC-S",
    "EBU-CLTO3.5W60K",
    "ECTSU-AMA4C5A",
    "ECTSU-RC1C8A",
    "ECTSU-WM4C1",
    "EHB-CUF100W50K",
    "EHB-CUF150W50K",
    "EHB-CUF150W50K-W",
    "EHB-CUF200W50K",
    "EHB-CUF200W50K-W",
    "EHB-CUF240W50K-W",
    "EHB-EUG2024W50K",
    "EHPB-LAW36D10-5K",
    "EHPB-LAW36D12-5K",
    "EHPB-LAW36D15-5K",
    "EPS-JBD-200W12V",
    "EPS-JBD-60W12V",
    "EPS-JBD-60W24V",
    "EPS-JBD-96W24V",
    "EPS-JBD5-300W12V",
    "EPS-JBND-150W12V",
    "EPS-JBND-150W24V",
    "EPS-JBND-300W12V",
    "ESB-C100WSF50K",
    "ESB-C300WSF50K-W",
    "ESLF-A4F40W-3CT",
    "ESP5V4-C20-06CT",
    "ESPS4R2W60W10RG",
    "ESPS5R4W90W12RG",
    "ETB-AHB4CC-5K",
    "EWP-A120W50K",
    "EWP-A41W50K",
    "EWP-A80W50K",
    "LRS-100-24",
    "SAT-65-571",
    "SUN-80531",
    "SUN-80532",
    "SUN-80533",
    "SUN-80896",
    "SUN-80897",
    "SUN-81120",
    "SUN-88395",
    "SUN-88396",
    "SUN-88397",
    "SUN-89204",
    "SUN-89206",
    "WE-ELB-2048-EXTR",
    "WE-FLD2-15W50KKN",
    "WE-FLD2-15WW-KN",
    "WE-FLD2-28-CW-KN",
    "WE-FLD2-28-WW-KN",
    "WE-FML-R10-MCT",
    "WE-LPN2X450W50KD",
    "WE-LPN2X460W50KD",
    "WE-RDPF4-MCT5",
    "WE-SCL-GSY10",
]

type ProductInfo = {
    id: string
    sku: string
    title: string
}

type DeletionStats = {
    variantInventoryLinks: number
    prices: number
    priceSets: number
    inventoryLevels: number
    inventoryItems: number
    attributeLinks: number
    variants: number
    products: number
}

export default async function deleteProductsBySku({ container }: ExecArgs) {
    const isDryRun = process.env.DRY_RUN !== "false"
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    })

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log(isDryRun ? "📋 DRY RUN MODE - No se eliminará nada" : "⚠️  DELETION MODE ACTIVE")
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")

    try {
        // 1. Obtener IDs de productos por SKU
        console.log("🔍 Buscando productos por SKU...")
        const products = await getProductsBySku(pool, SKUS_TO_DELETE)

        if (products.length === 0) {
            console.log("\n❌ No se encontraron productos con los SKUs especificados.")
            await pool.end()
            return
        }

        console.log(`\n✓ Productos encontrados: ${products.length}/${SKUS_TO_DELETE.length} SKUs\n`)

        // Mostrar productos encontrados
        products.forEach((p, idx) => {
            console.log(`   ${idx + 1}. ${p.sku} - "${p.title}" (ID: ${p.id})`)
        })

        // Detectar SKUs no encontrados
        const foundSkus = products.map(p => p.sku)
        const notFoundSkus = SKUS_TO_DELETE.filter(sku => !foundSkus.includes(sku))

        if (notFoundSkus.length > 0) {
            console.log(`\n⚠️  SKUs no encontrados (${notFoundSkus.length}):`)
            notFoundSkus.forEach(sku => console.log(`   • ${sku}`))
        }

        const productIds = products.map(p => p.id)

        // 2. Calcular estadísticas de eliminación
        console.log("\n📊 Calculando impacto de eliminación...\n")
        const stats = await calculateDeletionStats(pool, productIds)

        console.log("   Registros a eliminar:")
        console.log(`   • product_variant_inventory_item: ${stats.variantInventoryLinks}`)
        console.log(`   • price: ${stats.prices}`)
        console.log(`   • price_set links: ${stats.priceSets}`)
        console.log(`   • inventory_level: ${stats.inventoryLevels}`)
        console.log(`   • inventory_item: ${stats.inventoryItems}`)
        console.log(`   • product_attribute links: ${stats.attributeLinks}`)
        console.log(`   • product_variant: ${stats.variants}`)
        console.log(`   • product: ${stats.products}`)

        const totalRecords = Object.values(stats).reduce((sum, count) => sum + count, 0)
        console.log(`\n   TOTAL: ${totalRecords} registros`)

        // 3. Ejecutar dry-run o eliminación real
        if (isDryRun) {
            console.log("\n✅ DRY RUN COMPLETADO - No se modificó la base de datos")
            console.log("\n   Para ejecutar la eliminación real:")
            console.log("   DRY_RUN=false npx medusa exec ./src/scripts/delete-products-by-sku.ts")
        } else {
            // Ejecutar eliminación transaccional
            await executeTransactionalDeletion(pool, productIds, stats)
            console.log("\n✅ ELIMINACIÓN COMPLETADA CON ÉXITO")
        }

    } catch (error) {
        console.error("\n❌ ERROR:", error)
        throw error
    } finally {
        await pool.end()
    }
}

/**
 * Obtiene información de productos por SKU
 * En Medusa v2, el SKU está en product_variant, no en product
 */
async function getProductsBySku(pool: Pool, skus: string[]): Promise<ProductInfo[]> {
    const placeholders = skus.map((_, i) => `$${i + 1}`).join(", ")

    const result = await pool.query(
        `SELECT DISTINCT p.id, pv.sku, p.title 
         FROM product p
         INNER JOIN product_variant pv ON pv.product_id = p.id
         WHERE pv.sku IN (${placeholders})
         ORDER BY pv.sku`,
        skus
    )

    return result.rows
}


/**
 * Calcula estadísticas de lo que se eliminará
 */
async function calculateDeletionStats(pool: Pool, productIds: string[]): Promise<DeletionStats> {
    const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ")

    // Obtener IDs de variantes
    const variantsResult = await pool.query(
        `SELECT id FROM product_variant WHERE product_id IN (${placeholders})`,
        productIds
    )
    const variantIds = variantsResult.rows.map(r => r.id)
    const variantPlaceholders = variantIds.map((_, i) => `$${i + 1}`).join(", ")

    // Contar registros en cada tabla
    const stats: DeletionStats = {
        variantInventoryLinks: 0,
        prices: 0,
        priceSets: 0,
        inventoryLevels: 0,
        inventoryItems: 0,
        attributeLinks: 0,
        variants: variantIds.length,
        products: productIds.length,
    }

    if (variantIds.length > 0) {
        // Variant-Inventory Links
        const viLinks = await pool.query(
            `SELECT COUNT(*) FROM product_variant_inventory_item WHERE variant_id IN (${variantPlaceholders})`,
            variantIds
        )
        stats.variantInventoryLinks = parseInt(viLinks.rows[0].count)

        // Inventory Items
        const invItems = await pool.query(
            `SELECT COUNT(DISTINCT inventory_item_id) FROM product_variant_inventory_item WHERE variant_id IN (${variantPlaceholders})`,
            variantIds
        )
        stats.inventoryItems = parseInt(invItems.rows[0].count)

        // Inventory Levels
        const invLevels = await pool.query(
            `SELECT COUNT(*) FROM inventory_level 
       WHERE inventory_item_id IN (
         SELECT DISTINCT inventory_item_id FROM product_variant_inventory_item 
         WHERE variant_id IN (${variantPlaceholders})
       )`,
            variantIds
        )
        stats.inventoryLevels = parseInt(invLevels.rows[0].count)

        // Price Sets (via product_variant_price_set)
        const priceSets = await pool.query(
            `SELECT COUNT(*) FROM product_variant_price_set 
       WHERE variant_id IN (${variantPlaceholders})`,
            variantIds
        )
        stats.priceSets = parseInt(priceSets.rows[0].count)

        // Prices
        const prices = await pool.query(
            `SELECT COUNT(*) FROM price 
       WHERE price_set_id IN (
         SELECT price_set_id FROM product_variant_price_set 
         WHERE variant_id IN (${variantPlaceholders})
       )`,
            variantIds
        )
        stats.prices = parseInt(prices.rows[0].count)
    }

    // Attribute Links (custom table)
    const attrLinks = await pool.query(
        `SELECT COUNT(*) FROM product_product_productattributes_attribute_value 
     WHERE product_id IN (${placeholders})`,
        productIds
    )
    stats.attributeLinks = parseInt(attrLinks.rows[0].count)

    return stats
}

/**
 * Ejecuta la eliminación en una transacción
 */
async function executeTransactionalDeletion(
    pool: Pool,
    productIds: string[],
    stats: DeletionStats
): Promise<void> {
    const client = await pool.connect()

    try {
        console.log("\n🔄 Iniciando transacción...")
        await client.query("BEGIN")

        const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ")

        // Obtener IDs de variantes
        const variantsResult = await client.query(
            `SELECT id FROM product_variant WHERE product_id IN (${placeholders})`,
            productIds
        )
        const variantIds = variantsResult.rows.map(r => r.id)

        if (variantIds.length > 0) {
            const variantPlaceholders = variantIds.map((_, i) => `$${i + 1}`).join(", ")

            // Paso 1: Eliminar Variant-Inventory Links
            console.log("\n   🗑️  Eliminando variant-inventory links...")
            await client.query(
                `DELETE FROM product_variant_inventory_item WHERE variant_id IN (${variantPlaceholders})`,
                variantIds
            )
            console.log(`      ✓ ${stats.variantInventoryLinks} links eliminados`)

            // Paso 2: Eliminar Precios
            console.log("\n   🗑️  Eliminando precios...")
            await client.query(
                `DELETE FROM price 
         WHERE price_set_id IN (
           SELECT price_set_id FROM product_variant_price_set 
           WHERE variant_id IN (${variantPlaceholders})
         )`,
                variantIds
            )
            console.log(`      ✓ ${stats.prices} precios eliminados`)

            // Paso 3: Eliminar Price Set Links
            console.log("\n   🗑️  Eliminando price set links...")
            await client.query(
                `DELETE FROM product_variant_price_set 
         WHERE variant_id IN (${variantPlaceholders})`,
                variantIds
            )
            console.log(`      ✓ ${stats.priceSets} links eliminados`)

            // Paso 4: Eliminar Inventory Levels
            console.log("\n   🗑️  Eliminando inventory levels...")
            await client.query(
                `DELETE FROM inventory_level 
         WHERE inventory_item_id IN (
           SELECT DISTINCT inventory_item_id FROM product_variant_inventory_item 
           WHERE variant_id IN (${variantPlaceholders})
         )`,
                variantIds
            )
            console.log(`      ✓ ${stats.inventoryLevels} levels eliminados`)

            // Paso 5: Eliminar Inventory Items
            console.log("\n   🗑️  Eliminando inventory items...")
            await client.query(
                `DELETE FROM inventory_item 
         WHERE id IN (
           SELECT DISTINCT inventory_item_id FROM product_variant_inventory_item 
           WHERE variant_id IN (${variantPlaceholders})
         )`,
                variantIds
            )
            console.log(`      ✓ ${stats.inventoryItems} items eliminados`)
        }

        // Paso 6: Eliminar Attribute Links
        console.log("\n   🗑️  Eliminando product attribute links...")
        await client.query(
            `DELETE FROM product_product_productattributes_attribute_value WHERE product_id IN (${placeholders})`,
            productIds
        )
        console.log(`      ✓ ${stats.attributeLinks} attribute links eliminados`)

        // Paso 7: Eliminar Variantes
        console.log("\n   🗑️  Eliminando variantes...")
        await client.query(
            `DELETE FROM product_variant WHERE product_id IN (${placeholders})`,
            productIds
        )
        console.log(`      ✓ ${stats.variants} variantes eliminadas`)

        // Paso 8: Eliminar Productos
        console.log("\n   🗑️  Eliminando productos...")
        await client.query(
            `DELETE FROM product WHERE id IN (${placeholders})`,
            productIds
        )
        console.log(`      ✓ ${stats.products} productos eliminados`)

        // Commit transaction
        console.log("\n   💾 Confirmando transacción...")
        await client.query("COMMIT")
        console.log("      ✓ Cambios confirmados en base de datos")

    } catch (error) {
        console.log("\n   ⏪ Error detectado - ejecutando ROLLBACK...")
        await client.query("ROLLBACK")
        console.log("      ✓ Todos los cambios revertidos")
        throw error
    } finally {
        client.release()
    }
}
