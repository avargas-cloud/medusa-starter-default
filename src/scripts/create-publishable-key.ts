import { execArgs } from "@medusajs/framework/types"

/**
 * Create Publishable API Key for Store Access
 * 
 * Medusa v2 requires publishable keys for store endpoints
 * This script creates one automatically
 */
export default async function createPublishableKey({ container }: execArgs) {
    console.log("\n🔑 Creating Publishable API Key for Store Access\n")

    try {
        const query = container.resolve("query")

        // Check if one already exists
        const { data: existingKeys } = await query.graph({
            entity: "publishable_api_key",
            fields: ["id", "title", "created_at"],
        })

        if (existingKeys && existingKeys.length > 0) {
            console.log("✅ Publishable API Key already exists:")
            console.log(`   ID: ${existingKeys[0].id}`)
            console.log(`   Title: ${existingKeys[0].title || "Default"}`)
            console.log(`\n   Add this to your .env:`)
            console.log(`   PUBLISHABLE_API_KEY=${existingKeys[0].id}`)
            return
        }

        // Create new publishable key
        const remoteLink = container.resolve("remoteLink")

        const publishableApiKey = await remoteLink.create({
            admin_publishable_api_key: {
                title: "Default Store Key - Google OAuth",
                created_by: "admin",
            }
        })

        console.log("✅ Created new Publishable API Key!")
        console.log(`   ID: ${publishableApiKey.id}`)
        console.log(`\n   Add this to your .env:`)
        console.log(`   PUBLISHABLE_API_KEY=${publishableApiKey.id}`)

    } catch (error: any) {
        console.error("\n❌ Error creating publishable key:", error.message)
        console.log("\n💡 Alternative: Create manually via Admin UI:")
        console.log("   1. Go to http://localhost:9000/app/settings/publishable-api-keys")
        console.log("   2. Click 'Create Key'")
        console.log("   3. Copy the key ID and add to .env")
    }
}
