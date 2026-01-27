import { ExecArgs } from "@medusajs/framework/types"
import { Pool } from "pg"

/**
 * Script para Eliminar Variantes Duplicadas sin Metadata
 * 
 * Problema: Algunos SKUs tienen 2 variantes:
 *   1. Una con metadata completo (quickbooks_id, mpn) - CONSERVAR
 *   2. Otra con metadata: null - ELIMINAR
 * 
 * Este script elimina SOLO las variantes que:
 *   - Tienen SKU duplicado
 *   - Tienen metadata = null o sin quickbooks_id
 * 
 * MODO DRY-RUN (Por defecto):
 *   DRY_RUN=true npx medusa exec ./src/scripts/cleanup-duplicate-variants.ts
 * 
 * MODO EJECUCIÓN REAL:
 *   DRY_RUN=false npx medusa exec ./src/scripts/cleanup-duplicate-variants.ts
 */

export default async function cleanupDuplicateVariants({ container }: ExecArgs) {
    const isDryRun = process.env.DRY_RUN !== "false"
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    })

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log(isDryRun ? "📋 DRY RUN MODE - No se modificará nada" : "⚠️  EXECUTION MODE ACTIVE")
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")

    try {
        // Paso 1: Encontrar SKUs duplicados
        console.log("🔍 Buscando SKUs duplicados...\n")

        const duplicatesQuery = await pool.query(`
      SELECT sku, COUNT(*) as count
      FROM product_variant
      WHERE sku IS NOT NULL
      GROUP BY sku
      HAVING COUNT(*) > 1
      ORDER BY sku
    `)

        const duplicatedSkus = duplicatesQuery.rows.map(r => r.sku)

        if (duplicatedSkus.length === 0) {
            console.log("✅ No se encontraron SKUs duplicados")
            return
        }

        console.log(`   ⚠️  Encontrados ${duplicatedSkus.length} SKUs duplicados:\n`)
        duplicatesQuery.rows.forEach((r, idx) => {
            console.log(`      ${idx + 1}. ${r.sku} (${r.count} variantes)`)
        })

        // Paso 2: Analizar duplicados y determinar cuál eliminar
        console.log("\n📊 Analizando duplicados...\n")

        const variantsToDelete: string[] = []
        const variantsToKeep: string[] = []

        for (const sku of duplicatedSkus) {
            const variants = await pool.query(
                `SELECT id, sku, metadata, product_id 
         FROM product_variant 
         WHERE sku = $1
         ORDER BY id`,
                [sku]
            )

            console.log(`\n   📌 SKU: ${sku}`)

            const withMetadata = variants.rows.filter(v =>
                v.metadata && v.metadata.quickbooks_id
            )
            const withoutMetadata = variants.rows.filter(v =>
                !v.metadata || !v.metadata.quickbooks_id
            )

            console.log(`      • Con metadata (quickbooks_id): ${withMetadata.length}`)
            console.log(`      • Sin metadata: ${withoutMetadata.length}`)

            if (withMetadata.length === 1 && withoutMetadata.length >= 1) {
                // Caso ideal: 1 con metadata, 1+ sin metadata
                variantsToKeep.push(withMetadata[0].id)
                withoutMetadata.forEach(v => variantsToDelete.push(v.id))
                console.log(`      ✓ Conservar: ${withMetadata[0].id}`)
                console.log(`      ✗ Eliminar: ${withoutMetadata.map(v => v.id).join(", ")}`)
            } else {
                // Caso complejo: necesita revisión manual
                console.log(`      ⚠️  CASO COMPLEJO - Requiere revisión manual`)
                variants.rows.forEach(v => {
                    console.log(`         - ${v.id}: metadata = ${v.metadata ? "✓" : "✗"}`)
                })
            }
        }

        if (variantsToDelete.length === 0) {
            console.log("\n✅ No hay variantes duplicadas para eliminar")
            return
        }

        // Paso 3: Mostrar resumen
        console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
        console.log("📋 RESUMEN:\n")
        console.log(`   • Variantes a conservar: ${variantsToKeep.length}`)
        console.log(`   • Variantes a eliminar: ${variantsToDelete.length}`)

        // Paso 4: Calcular impacto
        const stats = await calculateDeletionStats(pool, variantsToDelete)

        console.log(`\n   📈 Impacto de eliminación:`)
        console.log(`      • Variantes: ${variantsToDelete.length}`)
        console.log(`      • Precios: ${stats.prices}`)
        console.log(`      • Price set links: ${stats.priceSets}`)
        console.log(`      • Inventory links: ${stats.inventoryLinks}`)

        // Paso 5: Ejecutar eliminación
        if (!isDryRun) {
            console.log("\n🔄 Ejecutando eliminación...\n")
            await executeVariantDeletion(pool, variantsToDelete)
            console.log(`   ✅ ${variantsToDelete.length} variantes duplicadas eliminadas`)
        } else {
            console.log("\n✅ DRY RUN COMPLETADO - No se modificó la base de datos")
            console.log("\n   Para ejecutar los cambios reales:")
            console.log("   DRY_RUN=false npx medusa exec ./src/scripts/cleanup-duplicate-variants.ts")
        }

    } catch (error) {
        console.error("\n❌ ERROR:", error)
        throw error
    } finally {
        await pool.end()
    }
}

/**
 * Calcula estadísticas de eliminación
 */
async function calculateDeletionStats(pool: Pool, variantIds: string[]) {
    if (variantIds.length === 0) {
        return { prices: 0, priceSets: 0, inventoryLinks: 0 }
    }

    const placeholders = variantIds.map((_, i) => `$${i + 1}`).join(", ")

    const priceSets = await pool.query(
        `SELECT COUNT(*) FROM product_variant_price_set WHERE variant_id IN (${placeholders})`,
        variantIds
    )

    const prices = await pool.query(
        `SELECT COUNT(*) FROM price WHERE price_set_id IN (
       SELECT price_set_id FROM product_variant_price_set WHERE variant_id IN (${placeholders})
     )`,
        variantIds
    )

    const inventoryLinks = await pool.query(
        `SELECT COUNT(*) FROM product_variant_inventory_item WHERE variant_id IN (${placeholders})`,
        variantIds
    )

    return {
        prices: parseInt(prices.rows[0].count),
        priceSets: parseInt(priceSets.rows[0].count),
        inventoryLinks: parseInt(inventoryLinks.rows[0].count),
    }
}

/**
 * Ejecuta la eliminación de variantes
 */
async function executeVariantDeletion(pool: Pool, variantIds: string[]) {
    const client = await pool.connect()

    try {
        await client.query("BEGIN")

        const placeholders = variantIds.map((_, i) => `$${i + 1}`).join(", ")

        // Eliminar en orden correcto
        await client.query(
            `DELETE FROM product_variant_inventory_item WHERE variant_id IN (${placeholders})`,
            variantIds
        )

        await client.query(
            `DELETE FROM price WHERE price_set_id IN (
         SELECT price_set_id FROM product_variant_price_set WHERE variant_id IN (${placeholders})
       )`,
            variantIds
        )

        await client.query(
            `DELETE FROM product_variant_price_set WHERE variant_id IN (${placeholders})`,
            variantIds
        )

        await client.query(
            `DELETE FROM product_variant WHERE id IN (${placeholders})`,
            variantIds
        )

        await client.query("COMMIT")
        console.log("   ✓ Transacción confirmada")
    } catch (error) {
        await client.query("ROLLBACK")
        console.error("   ✗ Error - Transacción revertida")
        throw error
    } finally {
        client.release()
    }
}
