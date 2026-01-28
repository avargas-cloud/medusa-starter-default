import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export default async function testCustomerUpdateEvent({ container }: ExecArgs) {
    console.log("🧪 Testing Customer Update Event...")

    const customerModule = container.resolve(Modules.CUSTOMER)

    // Find any customer
    const [customer] = await customerModule.listCustomers({}, { take: 1 })

    if (!customer) {
        console.error("❌ No customers found")
        return
    }

    console.log(`📦 Found customer: ${customer.email} (${customer.id})`)

    // Trigger an update
    console.log("🔄 Updating customer phone...")
    await customerModule.updateCustomers({
        id: customer.id,
        phone: customer.phone || "000-000-0000"
    })

    console.log("✅ Update sent. Check terminal for subscriber logs...")
    console.log("   Looking for: '⚡ [Customer Subscriber] Event triggered...'")

    await new Promise(resolve => setTimeout(resolve, 3000))
}
