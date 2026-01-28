import { ExecArgs } from "@medusajs/framework/types"

export default async function updateVargasMetadata({ container }: ExecArgs) {
    const customerService = container.resolve("customer")
    const query = container.resolve("query")

    console.log("🔍 Finding Alejandro Vargas...")

    // Find by email which we saw in logs earlier
    const { data: customers } = await query.graph({
        entity: "customer",
        fields: ["id", "email", "metadata"],
        filters: {
            email: "a.vargas@ecopowertech.com" // Known email from logs
        }
    })

    if (customers.length === 0) {
        console.error("❌ Customer not found!")
        return
    }

    const customer = customers[0]
    console.log(`✅ Found Customer: ${customer.id}`)

    // Prepare Metadata update
    // User provided: "8000004E-1342117388", "Alejandro Vargas"
    const newMetadata = {
        ...customer.metadata,
        qb_list_id: "8000004E-1342117388",
        qb_price_level: "Retail", // Defaulting to Retail as per user context
        qb_customer_type: "Retail" // Defaulting to Retail
    }

    console.log("📝 Updating Metadata to:", newMetadata)

    await customerService.updateCustomers(customer.id, {
        metadata: newMetadata
    })

    console.log("✅ Update Complete.")
}
