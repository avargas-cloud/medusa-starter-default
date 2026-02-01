import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { IProductModuleService } from "@medusajs/framework/types"

/**
 * Clean Product Metadata - Remove Old Category References
 * 
 * This script:
 * 1. Finds all products with primary_category_id in metadata
 * 2. Validates if the category still exists
 * 3. If not, removes the old reference and recalculates breadcrumbs
 * 4. Updates main_category_breadcrumbs with current data
 */

async function getCategoryBreadcrumbs(
    categoryId: string,
    productModuleService: IProductModuleService
): Promise<any[]> {
    const breadcrumbs: any[] = []
    let currentCategoryId: string | null = categoryId

    while (currentCategoryId) {
        try {
            const category = await productModuleService.retrieveProductCategory(currentCategoryId, {
                select: ["id", "name", "handle", "parent_category_id"]
            })

            breadcrumbs.unshift({
                id: category.id,
                name: category.name,
                handle: category.handle
            })

            currentCategoryId = category.parent_category_id || null
        } catch (error) {
            // Category doesn't exist, stop here
            console.log(`   ⚠️  Category ${currentCategoryId} not found, stopping breadcrumb trail`)
            break
        }
    }

    return breadcrumbs
}

export default async function cleanProductMetadata({ container }: any) {
    const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    const productModuleService: IProductModuleService = container.resolve(Modules.PRODUCT)

    console.log('\n🧹 CLEANING PRODUCT METADATA - CATEGORY REFERENCES\n')
    console.log('=' * 70)

    // Get all products with metadata
    const products = await knex('product')
        .select('id', 'title', 'metadata')
        .whereNotNull('metadata')

    console.log(`📦 Found ${products.length} products with metadata\n`)

    let updatedCount = 0
    let errorCount = 0
    let alreadyCleanCount = 0

    for (const product of products) {
        const metadata = product.metadata || {}
        let needsUpdate = false
        const updates: any = { ...metadata }

        // Check primary_category_id
        if (metadata.primary_category_id) {
            try {
                await productModuleService.retrieveProductCategory(metadata.primary_category_id)
                // Category exists, keep it
            } catch (error) {
                console.log(`❌ ${product.title}`)
                console.log(`   Old primary_category_id: ${metadata.primary_category_id}`)

                // Get current categories
                const productWithCats = await productModuleService.retrieveProduct(product.id, {
                    relations: ["categories"]
                })

                if (productWithCats.categories && productWithCats.categories.length > 0) {
                    // Use first available category
                    const newPrimaryId = productWithCats.categories[0].id
                    updates.primary_category_id = newPrimaryId
                    console.log(`   ✅ New primary_category_id: ${newPrimaryId}`)
                    needsUpdate = true
                } else {
                    // No categories, remove the field
                    delete updates.primary_category_id
                    delete updates.main_category_breadcrumbs
                    console.log(`   ⚠️  No categories assigned, removing metadata`)
                    needsUpdate = true
                }
            }
        }

        // Recalculate breadcrumbs if we have a primary category
        if (updates.primary_category_id) {
            try {
                const breadcrumbs = await getCategoryBreadcrumbs(updates.primary_category_id, productModuleService)
                const oldBreadcrumbs = JSON.stringify(metadata.main_category_breadcrumbs || [])
                const newBreadcrumbs = JSON.stringify(breadcrumbs)

                if (oldBreadcrumbs !== newBreadcrumbs) {
                    updates.main_category_breadcrumbs = breadcrumbs
                    console.log(`   🔄 Updated breadcrumbs (${breadcrumbs.length} levels)`)
                    needsUpdate = true
                }
            } catch (error) {
                console.log(`   ⚠️  Could not calculate breadcrumbs: ${error instanceof Error ? error.message : error}`)
                errorCount++
            }
        }

        // Update product if needed
        if (needsUpdate) {
            try {
                await knex('product')
                    .where('id', product.id)
                    .update({
                        metadata: JSON.stringify(updates),
                        updated_at: new Date()
                    })

                updatedCount++
            } catch (error) {
                console.log(`   💥 Error updating product: ${error instanceof Error ? error.message : error}`)
                errorCount++
            }
        } else {
            alreadyCleanCount++
        }
    }

    console.log('\n' + '='.repeat(70))
    console.log('📊 SUMMARY')
    console.log('='.repeat(70))
    console.log(`✅ Updated: ${updatedCount} products`)
    console.log(`✓  Already clean: ${alreadyCleanCount} products`)
    console.log(`❌ Errors: ${errorCount}`)
    console.log('='.repeat(70))
    console.log('\n✨ Cleanup complete!\n')
}
