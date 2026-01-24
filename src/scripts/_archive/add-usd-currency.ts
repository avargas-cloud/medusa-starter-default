import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Add USD Currency to System
 * 
 * Ensures USD currency exists and is properly configured
 */

export default async function addUSDCurrency({ container }: { container: MedusaContainer }) {
    console.log("💵 Adding USD Currency to System...\n")

    const currencyService = container.resolve(Modules.CURRENCY)
    const storeService = container.resolve(Modules.STORE)

    // Check if USD exists
    const existing = await currencyService.listCurrencies({ code: "usd" })

    if (existing.length === 0) {
        console.log("Creating USD currency...")
        await currencyService.createCurrencies({
            code: "usd",
            name: "US Dollar",
            symbol: "$",
            symbol_native: "$"
        })
        console.log("✅ USD currency created")
    } else {
        console.log("✅ USD currency already exists")
    }

    // List all available currencies
    const allCurrencies = await currencyService.listCurrencies()
    console.log(`\n📋 Available currencies:`)
    for (const curr of allCurrencies) {
        console.log(`   - ${curr.code.toUpperCase()}: ${curr.name}`)
    }

    console.log(`\n⚠️  MANUAL STEP REQUIRED:`)
    console.log(`   1. Go to Settings → Store in admin`)
    console.log(`   2. Click "Edit" button`)
    console.log(`   3. In "Default currency" dropdown, select USD`)
    console.log(`   4. Click "Add currency" if needed to add USD to store`)
    console.log(`   5. Save changes`)
    console.log(`\n📝 Note: The API doesn't allow programmatic currency assignment to store.`)

    return { success: true }
}
