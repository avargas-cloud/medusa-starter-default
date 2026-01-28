import "dotenv/config"
import { ExecArgs } from "@medusajs/framework/types"

export default async function testConnections({ container }: ExecArgs) {
    console.log("🚀 Testing Connections...")
    console.log("DB URL:", process.env.DATABASE_URL?.split("@")[1]) // Log only host part
    console.log("Redis URL:", process.env.REDIS_URL?.split("@")[1]) // Log only host part

    // Test Redis
    try {
        const { Redis } = await import("ioredis")
        const redis = new Redis(process.env.REDIS_URL!)
        await redis.ping()
        console.log("✅ Redis Connected!")
        redis.disconnect()
    } catch (e) {
        console.error("❌ Redis Failed:", e.message)
    }

    // Test Postgres (using PG directly to skip Medusa layer)
    try {
        const { Client } = await import("pg")
        const client = new Client({ connectionString: process.env.DATABASE_URL })
        await client.connect()
        const res = await client.query('SELECT NOW()')
        console.log("✅ Postgres Connected! Time:", res.rows[0].now)
        await client.end()
    } catch (e) {
        console.error("❌ Postgres Failed:", e.message)
    }
}

// Self-execute if running directly with tsx
if (require.main === module || process.argv[1].includes('tsx')) {
    testConnections({} as any)
}
