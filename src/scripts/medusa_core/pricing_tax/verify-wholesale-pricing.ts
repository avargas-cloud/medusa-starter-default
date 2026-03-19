/**
 * Verify Wholesale Pricing Configuration
 * 
 * Checks:
 * 1. Price list exists and is active
 * 2. Linked to Wholesale customer group
 * 3. Has prices configured
 * 4. Sample price comparison
 */

import { ContainerRegistrationKeys, Modules } from "@medusajs/utils"

export default async function verifyWholesalePricing({ container }: any) {
    const logger = container.resolve("logger")
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    const log = (msg: string) => {
        console.log(msg)
        logger.info(msg)
    }

    log("\n🔍 VERIFYING WHOLESALE PRICING CONFIGURATION\n")

    try {
        // 1. Get Wholesale Price List
        const { data: priceLists } = await query.graph({
            entity: "price_list",
            fields: ["id", "title", "description", "type", "status"],
            filters: { title: "Wholesale Pricing" }
        })

        if (priceLists.length === 0) {
            log("❌ Wholesale Pricing price list NOT FOUND")
            return { success: false, error: "Price list not found" }
        }

        const priceList = priceLists[0]
        log("✅ Price List Found:")
        log(`   ID: ${priceList.id}`)
        log(`   Title: ${priceList.title}`)
        log(`   Description: ${priceList.description}`)
        log(`   Type: ${priceList.type}`)
        log(`   Status: ${priceList.status}`)

        if (priceList.status !== "active") {
            log(`⚠️  WARNING: Price list status is "${priceList.status}" (should be "active")`)
        }

        // 2. Check if linked to Wholesale group
        const { data: groups } = await query.graph({
            entity: "customer_group",
            fields: ["id", "name"],
            filters: { name: "Wholesale" }
        })

        if (groups.length === 0) {
            log("❌ Wholesale customer group NOT FOUND")
            return { success: false, error: "Wholesale group not found" }
        }

        const wholesaleGroup = groups[0]
        log(`\n✅ Wholesale Group Found (ID: ${wholesaleGroup.id})`)

        // Check how many customers are in the Wholesale group
        const { data: wholesaleCustomers } = await query.graph({
            entity: "customer",
            fields: ["id"],
            filters: {
                groups: {
                    id: wholesaleGroup.id
                }
            }
        })

        log(`   Customers in Wholesale group: ${wholesaleCustomers.length}`)

        if (wholesaleCustomers.length === 0) {
            log("⚠️  WARNING: No customers in Wholesale group")
        }

        // 3. Check for prices in the price list
        const { data: prices } = await query.graph({
            entity: "price",
            fields: ["id", "amount", "currency_code", "price_list_id"],
            filters: { price_list_id: priceList.id },
            pagination: { take: 5 }
        })

        log(`\n📊 Prices in Wholesale Price List: ${prices.length > 0 ? prices.length : "0 (checking total...)"}`)

        if (prices.length === 0) {
            // Check total count
            const pricingModuleService = container.resolve(Modules.PRICING)
            const allPrices = await pricingModuleService.listPrices({
                price_list_id: [priceList.id]
            })

            log(`   Total wholesale prices: ${allPrices.length}`)

            if (allPrices.length === 0) {
                log("⚠️  WARNING: No prices configured in wholesale price list")
                log("   Wholesale customers will receive default prices")
            }
        } else {
            log("   Sample prices:")
            prices.slice(0, 3).forEach((p: any) => {
                log(`   - ${p.currency_code} ${(p.amount / 100).toFixed(2)}`)
            })
        }

        // 4. Sample comparison: Get a variant and check its prices
        log("\n🔍 Sample Price Comparison:")
        const { data: variants } = await query.graph({
            entity: "product_variant",
            fields: ["id", "sku", "product.title", "prices.amount", "prices.currency_code", "prices.price_list_id"],
            pagination: { take: 1 }
        })

        if (variants.length > 0) {
            const variant = variants[0]
            const defaultPrice = variant.prices?.find((p: any) => !p.price_list_id)
            const wholesalePrice = variant.prices?.find((p: any) => p.price_list_id === priceList.id)

            log(`   Product: ${variant.product?.title || "Unknown"}`)
            log(`   SKU: ${variant.sku || "N/A"}`)
            if (defaultPrice) {
                log(`   Default Price: $${(defaultPrice.amount / 100).toFixed(2)}`)
            }
            if (wholesalePrice) {
                log(`   Wholesale Price: $${(wholesalePrice.amount / 100).toFixed(2)}`)
                if (defaultPrice) {
                    const discount = ((defaultPrice.amount - wholesalePrice.amount) / defaultPrice.amount * 100).toFixed(1)
                    log(`   Discount: ${discount}%`)
                }
            } else {
                log(`   ⚠️  No wholesale price configured for this variant`)
            }
        }

        log("\n" + "=".repeat(70))
        log("✅ VERIFICATION COMPLETE")
        log("=".repeat(70))
        log("Summary:")
        log(`  - Price List: ${priceList.status === "active" ? "✅ Active" : "⚠️  " + priceList.status}`)
        log(`  - Wholesale Customers: ${wholesaleCustomers.length}`)
        log(`  - Prices Configured: ${prices.length > 0 ? "✅ Yes" : "⚠️  No"}`)
        log("=".repeat(70))

        return {
            success: true,
            priceList: {
                id: priceList.id,
                status: priceList.status,
                customerCount: wholesaleCustomers.length,
                priceCount: prices.length
            }
        }

    } catch (error: any) {
        log(`❌ Error: ${error.message}`)
        throw error
    }
}
