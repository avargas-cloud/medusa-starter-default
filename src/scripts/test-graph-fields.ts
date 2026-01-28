import { ExecArgs } from "@medusajs/framework/types"

export default async function testGraphFields({ container }: ExecArgs) {
    const query = container.resolve("query")
    console.log("🕵️ Testing Graph Fields...")

    try {
        const { data: customers } = await query.graph({
            entity: "customer",
            fields: [
                "id",
                "email",
                "company_name", // Testing this specific field
                "groups.*"      // Testing this too
            ],
        })
        console.log("✅ Query Success. Company Name:", customers[0]?.company_name)
    } catch (e: any) {
        console.error("❌ Query Failed:", e.message)
        console.log("Full error:", e)
    }
}
