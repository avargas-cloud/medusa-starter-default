/**
 * Restructure Product Types
 * 
 * This script:
 * 1. Audits current Product Type usage
 * 2. Creates standard Product Types (Physical Product, Digital Product, Service)
 * 3. Migrates all existing products to "Physical Product"
 * 4. Deletes old LED-specific Product Types
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

export default async function restructureProductTypes({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)
    const productModuleService = container.resolve(Modules.PRODUCT)

    logger.info("🔍 Starting Product Type Restructuring...")

    const report = {
        phase1_audit: {} as any,
        phase2_creation: {} as any,
        phase3_migration: {} as any,
        phase4_cleanup: {} as any,
    }

    try {
        // ========================================
        // PHASE 1: AUDIT CURRENT PRODUCT TYPES
        // ========================================
        logger.info("\n📊 PHASE 1: Auditing Current Product Types")

        const { data: existingTypes } = await query.graph({
            entity: "product_type",
            fields: ["id", "value", "created_at"],
        })

        logger.info(`Found ${existingTypes.length} existing Product Types:`)
        existingTypes.forEach((pt: any) => {
            logger.info(`  - ${pt.value} (ID: ${pt.id})`)
        })

        // Get products per type
        const productTypeUsage: Record<string, number> = {}
        const { data: products } = await query.graph({
            entity: "product",
            fields: ["id", "title", "type_id", "type.*"],
        })

        let productsWithoutType = 0
        products.forEach((product: any) => {
            if (!product.type_id) {
                productsWithoutType++
            } else {
                const typeName = product.type?.value || "Unknown"
                productTypeUsage[typeName] = (productTypeUsage[typeName] || 0) + 1
            }
        })

        logger.info(`\n📈 Product Type Usage:`)
        Object.entries(productTypeUsage).forEach(([type, count]) => {
            logger.info(`  - ${type}: ${count} products`)
        })
        logger.info(`  - No Type: ${productsWithoutType} products`)

        report.phase1_audit = {
            existingTypes: existingTypes.map((t: any) => ({ id: t.id, value: t.value })),
            usage: productTypeUsage,
            productsWithoutType,
            totalProducts: products.length,
        }

        // ========================================
        // PHASE 2: CREATE STANDARD PRODUCT TYPES
        // ========================================
        logger.info("\n🏗️  PHASE 2: Creating Standard Product Types")

        const standardTypes = ["Physical Product", "Digital Product", "Service"]
        const createdTypes: any[] = []

        for (const typeName of standardTypes) {
            // Check if it already exists
            const existing = existingTypes.find((t: any) => t.value === typeName)

            if (existing) {
                logger.info(`  ✓ "${typeName}" already exists (ID: ${existing.id})`)
                createdTypes.push(existing)
            } else {
                logger.info(`  ➕ Creating "${typeName}"...`)
                const [newType] = await productModuleService.createProductTypes([
                    { value: typeName }
                ])

                logger.info(`  ✓ Created "${typeName}" (ID: ${newType.id})`)
                createdTypes.push(newType)
            }
        }

        report.phase2_creation = {
            standardTypes,
            created: createdTypes.map((t: any) => ({ id: t.id, value: t.value })),
        }

        // ========================================
        // PHASE 3: MIGRATE PRODUCTS TO "Physical Product"
        // ========================================
        logger.info("\n🔄 PHASE 3: Migrating Products to 'Physical Product'")

        const physicalProductType = createdTypes.find((t: any) => t.value === "Physical Product")

        if (!physicalProductType) {
            throw new Error("Failed to create/find 'Physical Product' type")
        }

        logger.info(`Physical Product Type ID: ${physicalProductType.id}`)

        // Get all products that need migration
        const productsToMigrate = products.filter((p: any) =>
            !p.type_id || p.type_id !== physicalProductType.id
        )

        logger.info(`Migrating ${productsToMigrate.length} products to "Physical Product"...`)

        let migratedCount = 0

        for (const product of productsToMigrate) {
            try {
                await productModuleService.updateProducts(product.id, {
                    type_id: physicalProductType.id
                })
                migratedCount++

                if (migratedCount % 50 === 0) {
                    logger.info(`  Migrated ${migratedCount}/${productsToMigrate.length} products...`)
                }
            } catch (error: any) {
                logger.error(`  ✗ Failed to migrate product ${product.id}: ${error.message}`)
            }
        }

        logger.info(`✓ Migrated ${migratedCount} products to "Physical Product"`)

        report.phase3_migration = {
            targetTypeId: physicalProductType.id,
            totalToMigrate: productsToMigrate.length,
            migrated: migratedCount,
            failed: productsToMigrate.length - migratedCount,
        }

        // ========================================
        // PHASE 4: DELETE OLD LED-SPECIFIC TYPES
        // ========================================
        logger.info("\n🗑️  PHASE 4: Cleaning Up Old Product Types")

        const typesToDelete = existingTypes.filter((t: any) =>
            !standardTypes.includes(t.value)
        )

        logger.info(`Deleting ${typesToDelete.length} old Product Types...`)

        let deletedCount = 0
        for (const oldType of typesToDelete) {
            try {
                await productModuleService.deleteProductTypes([oldType.id])
                logger.info(`  ✓ Deleted "${oldType.value}"`)
                deletedCount++
            } catch (error: any) {
                logger.error(`  ✗ Failed to delete "${oldType.value}": ${error.message}`)
            }
        }

        logger.info(`✓ Deleted ${deletedCount} old Product Types`)

        report.phase4_cleanup = {
            totalOldTypes: typesToDelete.length,
            deleted: deletedCount,
            failed: typesToDelete.length - deletedCount,
        }

        // ========================================
        // FINAL REPORT
        // ========================================
        logger.info("\n" + "=".repeat(60))
        logger.info("✅ RESTRUCTURING COMPLETE!")
        logger.info("=".repeat(60))
        logger.info(`📊 Products migrated: ${migratedCount}`)
        logger.info(`🏗️  Standard types created: ${createdTypes.length}`)
        logger.info(`🗑️  Old types deleted: ${deletedCount}`)
        logger.info("=".repeat(60))

        return {
            success: true,
            report,
            summary: {
                productsMigrated: migratedCount,
                standardTypesCreated: createdTypes.length,
                oldTypesDeleted: deletedCount,
            }
        }

    } catch (error: any) {
        logger.error(`❌ Error during restructuring: ${error.message}`)
        logger.error(error.stack)

        throw error
    }
}
