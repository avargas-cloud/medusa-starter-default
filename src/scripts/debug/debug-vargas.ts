import { ExecArgs } from "@medusajs/framework/types"

export default async function debugVargas({ container }: ExecArgs) {
    const query = container.resolve("query")

    console.log("🕵️ Inspecting Alejandro Vargas...")

    const { data: customers } = await query.graph({
        entity: "customer",
        fields: [
            "id",
            "email",
            "first_name",
            "last_name",
            "metadata",
            "groups.*"
        ],
        filters: {
            email: "a.vargas@ecopowertech.com"
        }
    })

    if (customers.length === 0) {
        console.log("❌ Customer not found!")
    } else {
        const c = customers[0]
        console.log("✅ Customer Found:", c.id)
        console.log("Metadata:", JSON.stringify(c.metadata, null, 2))
        console.log("Groups:", c.groups?.map((g: any) => g.name))
    }
}
