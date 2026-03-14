import { ExecArgs } from "@medusajs/framework/types"
import { Pool } from "pg"

/**
 * Script de Limpieza y Renombrado de SKUs
 * 
 * OPERACIÓN 1: Eliminar productos con SKU único (obsoletos)
 * OPERACIÓN 2: Renombrar SKUs (viejo → nuevo)
 * 
 * MODO DRY-RUN (Por defecto):
 *   DRY_RUN=true npx medusa exec ./src/scripts/cleanup-and-rename-skus.ts
 * 
 * MODO EJECUCIÓN REAL:
 *   DRY_RUN=false npx medusa exec ./src/scripts/cleanup-and-rename-skus.ts
 */

const SKU_OPERATIONS = {
    // OPERACIÓN 1: SKUs a eliminar completamente (73 productos - incluye 2 conflictos)
    delete: [
        "BL-R4-G19SAT",
        "EAP-CP1-EC-S-1",
        "EAP-V-MB",
        "ECLDLE-3R8WS3CT-3", // Conflicto: ECLDLE-34R8WS3CT ya existe
        "ECLDLE-3R8WW3CT-3", // Conflicto: ECLDLE-34R8WW3CT ya existe
        "ECLDLE-4R8WS3CT-4",
        "ECLDLE-4R8WW3CT-4",
        "ECNA-2SCR2P-08",
        "ECNA-2SCR2P-10",
        "ECNA-2SCR4P-10",
        "ECNA-2SCR5P-12",
        "ECNA-2SW2P-08",
        "ECNA-2SW2P-10",
        "ECNA-2SW4P-10",
        "ECNA-2SW5P-12",
        "ECNA-BC-SS2P-08",
        "ECNA-BC-SW2P-08",
        "ECNA-PLUG2-SC-2",
        "ECNA-SL-SW2P-08",
        "ECNA-SL-SW4P-10",
        "ECTSK-RFRC1C15A-G",
        "ECTSK-RFRC3C4A-G",
        "ECTSK-RFRC4C5A-G",
        "ECTSK-TWRC5C3A-DM-G",
        "ECTSK-TWRC5C3A-G",
        "ECTSK-TWRC5C6A-DM-G",
        "ECTSK-TWRC5C6A-G",
        "EHPB-LAW36D05-5K",
        "EHPB-LAW36D07-5K",
        "ESB-C450WSA50K",
        "ESPC5R4N40W0827",
        "ESPC5R4N40W0850",
        "ESPS4R2W55W10RG",
        "ETPF-EA40W-50K",
        "EWP-6/8/10-0WCCT",
        "EWW-SF1V1FRGB15D",
        "EWW-SF1V1FRGB30D",
        "EWW-SF1V1FRGB45D",
        "FML-R8-MCT",
        "LEG-ACNRFCG1",
        "LEG-ADPD4FBL3P2M4",
        "LEG-ADPD4FBL3P2W4",
        "LEG-ADTH4FBL3PG4",
        "LEG-ADTH4FBL3PM4",
        "LEG-ADTH4FBL3PW4",
        "LEG-AGFTR2153M4",
        "LEG-AWM1G3MS4",
        "LEG-AWM1G3MW4",
        "LEG-AWP5GBR1",
        "LEG-AWP6GBR1",
        "RP-8202HA-G",
        "sku-9998",
        "sku_import-placeholder-for-236",
        "sku_import-placeholder-for-238",
        "sku_import-placeholder-for-239",
        "sku_import-placeholder-for-306",
        "sku_import-placeholder-for-308",
        "sku_import-placeholder-for-309",
        "sku_import-placeholder-for-45",
        "sku_import-placeholder-for-648",
        "sku_i-see-you",
        "sku_mug-bheart",
        "sku_phone-case-stve",
        "sku_trianglepy",
        "sku_t-shirt-four",
        "sku_t-shirt-ne",
        "sku_t-shirt-three",
        "sku_t-shirt-two",
        "SUP-AP-IP-RM1-S",
        "SUP-AP-IP-SM1-S",
        "SVC-ASSEMBLY-PANELS",
        "WE-LFXMD50W3K-TR",
        "XLG-75-12A",
    ],

    // OPERACIÓN 2: SKUs a renombrar (viejo → nuevo) - 20 renombrados
    rename: {
        "E01SLIL001": "EIN-18S-06-30K",
        "E01SLIL002": "EIN-18S-06-60K",
        "E01SLIL003": "EIN-36S-08-30K",
        "E01SLIL004": "EIN-36S-08-60K",
        "ECLDLE-34R-S3": "ECLDLE-34-3RDBN",
        "ECLDLE-34R-S4": "ECLDLE-34-4RDBN",
        "ECLDLE-34R-WH3": "ECLDLE-34-3RDWH",
        "ECLDLE-34R-WH4": "ECLDLE-34-4RDWH",
        "ECNA-6F2PR-B": "ECNA-POC2-6F-B",
        "ECNA-6F3PR-B": "ECNA-POC3-6F-B",
        "ECNA-CC-CR2P-08": "ECN-EDG-CR2P-08",
        "ECNA-CC-CR2P-10": "ECN-EDG-CR2P-10",
        "ECNA-CC-SS2P-08": "ECN-EDG-SS2P-08",
        "ECNA-CC-SS2P-10": "ECN-EDG-SS2P-10",
        "ECNA-CC-SW2P-08": "ECN-EDG-PIGD-08",
        "ECNA-CC-SW2P-10": "ECN-EDG-PIGD-10",
        "ECNA-CC-SWN2P-08": "ECN-EDG-WIS2P-08",
        "ECNA-CC-SWN2P-10": "ECN-EDG-WIS2P-10",
        "ECTSK-RM34C4Z": "ECTSK-RM3&4C4Z",
        "MG-E96L24DC-KO": "MG-E96L24DC",
    }
}

type RenameResult = {
    oldSku: string
    newSku: string
    variantsRenamed: number
    inventoryRenamed: number
    skipped: boolean
    reason?: string
}

export default async function cleanupAndRenameSKUs({ container }: ExecArgs) {
    const isDryRun = process.env.DRY_RUN !== "false"
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    })

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log(isDryRun ? "📋 DRY RUN MODE - No se modificará nada" : "⚠️  EXECUTION MODE ACTIVE")
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")

    try {
        // OPERACIÓN 1: ELIMINAR PRODUCTOS
        console.log("📊 OPERACIÓN 1: ELIMINAR PRODUCTOS OBSOLETOS\n")
        console.log(`   • ${SKU_OPERATIONS.delete.length} SKUs a eliminar\n`)

        const deleteProducts = await getProductsBySku(pool, SKU_OPERATIONS.delete)

        if (deleteProducts.length > 0) {
            console.log(`   ✓ Encontrados ${deleteProducts.length} productos para eliminar:\n`)
            deleteProducts.forEach((p, idx) => {
                console.log(`      ${idx + 1}. ${p.sku} - "${p.title}"`)
            })

            const deleteProductIds = deleteProducts.map(p => p.id)
            const deleteStats = await calculateDeletionStats(pool, deleteProductIds)

            console.log(`\n   📈 Impacto de eliminación:`)
            console.log(`      • Variantes: ${deleteStats.variants}`)
            console.log(`      • Precios: ${deleteStats.prices}`)
            console.log(`      • Inventory items: ${deleteStats.inventoryItems}`)
            console.log(`      • Attribute links: ${deleteStats.attributeLinks}`)
            console.log(`      • TOTAL registros: ${Object.values(deleteStats).reduce((a, b) => a + b, 0)}`)

            if (!isDryRun) {
                await executeProductDeletion(pool, deleteProductIds, deleteStats)
                console.log(`\n   ✅ ${deleteProducts.length} productos eliminados`)
            }
        } else {
            console.log("   ℹ️  No se encontraron productos para eliminar")
        }

        // OPERACIÓN 2: RENOMBRAR SKUs
        console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
        console.log("📊 OPERACIÓN 2: RENOMBRAR SKUs\n")
        console.log(`   • ${Object.keys(SKU_OPERATIONS.rename).length} renombrados a procesar\n`)

        const renameResults = await processRenames(pool, SKU_OPERATIONS.rename, isDryRun)

        // Resumen de renombrados
        const successful = renameResults.filter(r => !r.skipped)
        const skipped = renameResults.filter(r => r.skipped)

        console.log(`\n   📈 Resultado:`)
        console.log(`      • Exitosos: ${successful.length}`)
        console.log(`      • Omitidos: ${skipped.length}`)

        if (skipped.length > 0) {
            console.log(`\n   ⚠️  SKUs omitidos:`)
            skipped.forEach(r => {
                console.log(`      • ${r.oldSku} → ${r.newSku} (${r.reason})`)
            })
        }

        // Mensaje final
        if (isDryRun) {
            console.log("\n✅ DRY RUN COMPLETADO - No se modificó la base de datos")
            console.log("\n   Para ejecutar los cambios reales:")
            console.log("   DRY_RUN=false npx medusa exec ./src/scripts/cleanup-and-rename-skus.ts")
        } else {
            console.log("\n✅ OPERACIONES COMPLETADAS CON ÉXITO")
            console.log(`   • ${deleteProducts.length} productos eliminados`)
            console.log(`   • ${successful.length} SKUs renombrados`)
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
 */
async function getProductsBySku(pool: Pool, skus: string[]): Promise<Array<{ id: string; sku: string; title: string }>> {
    if (skus.length === 0) return []

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
 * Calcula estadísticas de eliminación
 */
async function calculateDeletionStats(pool: Pool, productIds: string[]) {
    const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ")

    const variantsResult = await pool.query(
        `SELECT id FROM product_variant WHERE product_id IN (${placeholders})`,
        productIds
    )
    const variantIds = variantsResult.rows.map(r => r.id)

    const stats = {
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
        const variantPlaceholders = variantIds.map((_, i) => `$${i + 1}`).join(", ")

        const viLinks = await pool.query(
            `SELECT COUNT(*) FROM product_variant_inventory_item WHERE variant_id IN (${variantPlaceholders})`,
            variantIds
        )
        stats.variantInventoryLinks = parseInt(viLinks.rows[0].count)

        const invItems = await pool.query(
            `SELECT COUNT(DISTINCT inventory_item_id) FROM product_variant_inventory_item WHERE variant_id IN (${variantPlaceholders})`,
            variantIds
        )
        stats.inventoryItems = parseInt(invItems.rows[0].count)

        const priceSets = await pool.query(
            `SELECT COUNT(*) FROM product_variant_price_set WHERE variant_id IN (${variantPlaceholders})`,
            variantIds
        )
        stats.priceSets = parseInt(priceSets.rows[0].count)

        const prices = await pool.query(
            `SELECT COUNT(*) FROM price WHERE price_set_id IN (
         SELECT price_set_id FROM product_variant_price_set WHERE variant_id IN (${variantPlaceholders})
       )`,
            variantIds
        )
        stats.prices = parseInt(prices.rows[0].count)
    }

    const attrLinks = await pool.query(
        `SELECT COUNT(*) FROM product_product_productattributes_attribute_value WHERE product_id IN (${placeholders})`,
        productIds
    )
    stats.attributeLinks = parseInt(attrLinks.rows[0].count)

    return stats
}

/**
 * Ejecuta la eliminación de productos
 */
async function executeProductDeletion(pool: Pool, productIds: string[], stats: any) {
    const client = await pool.connect()

    try {
        await client.query("BEGIN")

        const placeholders = productIds.map((_, i) => `$${i + 1}`).join(", ")

        const variantsResult = await client.query(
            `SELECT id FROM product_variant WHERE product_id IN (${placeholders})`,
            productIds
        )
        const variantIds = variantsResult.rows.map(r => r.id)

        if (variantIds.length > 0) {
            const variantPlaceholders = variantIds.map((_, i) => `$${i + 1}`).join(", ")

            await client.query(
                `DELETE FROM product_variant_inventory_item WHERE variant_id IN (${variantPlaceholders})`,
                variantIds
            )

            await client.query(
                `DELETE FROM price WHERE price_set_id IN (
           SELECT price_set_id FROM product_variant_price_set WHERE variant_id IN (${variantPlaceholders})
         )`,
                variantIds
            )

            await client.query(
                `DELETE FROM product_variant_price_set WHERE variant_id IN (${variantPlaceholders})`,
                variantIds
            )

            await client.query(
                `DELETE FROM inventory_item WHERE id IN (
           SELECT DISTINCT inventory_item_id FROM product_variant_inventory_item 
           WHERE variant_id IN (${variantPlaceholders})
         )`,
                variantIds
            )
        }

        await client.query(
            `DELETE FROM product_product_productattributes_attribute_value WHERE product_id IN (${placeholders})`,
            productIds
        )

        await client.query(
            `DELETE FROM product_variant WHERE product_id IN (${placeholders})`,
            productIds
        )

        await client.query(
            `DELETE FROM product WHERE id IN (${placeholders})`,
            productIds
        )

        await client.query("COMMIT")
    } catch (error) {
        await client.query("ROLLBACK")
        throw error
    } finally {
        client.release()
    }
}

/**
 * Procesa todos los renombrados de SKU
 */
async function processRenames(
    pool: Pool,
    renameMap: Record<string, string>,
    isDryRun: boolean
): Promise<RenameResult[]> {
    const results: RenameResult[] = []

    for (const [oldSku, newSku] of Object.entries(renameMap)) {
        console.log(`\n   🔄 Procesando: ${oldSku} → ${newSku}`)

        // Verificar si el SKU viejo existe
        const oldExists = await pool.query(
            `SELECT COUNT(*) FROM product_variant WHERE sku = $1`,
            [oldSku]
        )

        if (parseInt(oldExists.rows[0].count) === 0) {
            console.log(`      ⚠️  SKU viejo no encontrado, omitiendo`)
            results.push({
                oldSku,
                newSku,
                variantsRenamed: 0,
                inventoryRenamed: 0,
                skipped: true,
                reason: "SKU viejo no existe"
            })
            continue
        }

        // Verificar si el SKU nuevo ya existe
        const newExists = await pool.query(
            `SELECT COUNT(*) FROM product_variant WHERE sku = $1`,
            [newSku]
        )

        if (parseInt(newExists.rows[0].count) > 0) {
            console.log(`      ❌ SKU nuevo ya existe, omitiendo por seguridad`)
            results.push({
                oldSku,
                newSku,
                variantsRenamed: 0,
                inventoryRenamed: 0,
                skipped: true,
                reason: "SKU nuevo ya existe (conflicto)"
            })
            continue
        }

        if (!isDryRun) {
            // Ejecutar renombrado
            const result = await executeRename(pool, oldSku, newSku)
            console.log(`      ✓ Renombrado: ${result.variantsRenamed} variantes, ${result.inventoryRenamed} inventory items`)
            results.push(result)
        } else {
            console.log(`      ✓ Listo para renombrar (dry-run)`)
            results.push({
                oldSku,
                newSku,
                variantsRenamed: 1,
                inventoryRenamed: 1,
                skipped: false
            })
        }
    }

    return results
}

/**
 * Ejecuta el renombrado de un SKU
 */
async function executeRename(pool: Pool, oldSku: string, newSku: string): Promise<RenameResult> {
    const client = await pool.connect()

    try {
        await client.query("BEGIN")

        // Renombrar en product_variant
        const variantResult = await client.query(
            `UPDATE product_variant SET sku = $1 WHERE sku = $2`,
            [newSku, oldSku]
        )

        // Renombrar en inventory_item (si existe)
        const inventoryResult = await client.query(
            `UPDATE inventory_item SET sku = $1 WHERE sku = $2`,
            [newSku, oldSku]
        )

        await client.query("COMMIT")

        return {
            oldSku,
            newSku,
            variantsRenamed: variantResult.rowCount || 0,
            inventoryRenamed: inventoryResult.rowCount || 0,
            skipped: false
        }
    } catch (error) {
        await client.query("ROLLBACK")
        throw error
    } finally {
        client.release()
    }
}
