import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/utils"
import Redis from "ioredis"
import dotenv from "dotenv"
import path from "path"

dotenv.config({ path: path.resolve(__dirname, "../../.env") })

export default async function verifyBackorder({ container }: ExecArgs) {
    const inventoryModule = container.resolve(Modules.INVENTORY) as any

    // ── 1. Check DB state via Medusa module ─────────────────────────────────
    console.log("\n📦 Sampling inventory items from PostgreSQL (via Medusa module):")
    const [items, count] = await inventoryModule.listAndCountInventoryItems(
        {},
        { take: 10, skip: 0 }
    )

    const withTrue = items.filter((i: any) => i.allow_backorder === true)
    const withFalse = items.filter((i: any) => i.allow_backorder !== true)

    for (const item of items) {
        const icon = item.allow_backorder ? "✅" : "❌"
        console.log(`  ${icon} ${item.sku || item.id}: allow_backorder=${item.allow_backorder}`)
    }
    console.log(`\n  Sample: ${withTrue.length}/${items.length} have allow_backorder=true (total items in DB: ${count})`)

    // ── 2. Check Redis cache state ───────────────────────────────────────────
    console.log("\n🔴 Checking Redis cache state:")
    const redisUrl = process.env.REDIS_URL
    if (!redisUrl) {
        console.log("  REDIS_URL not set, skipping Redis check")
        return
    }

    const redis = new Redis(redisUrl)
    try {
        const totalKeys = await redis.dbsize()
        console.log(`  Total keys in Redis: ${totalKeys}`)

        // Scan for inventory-related keys
        const [, invKeys] = await redis.scan(0, "MATCH", "*inventor*", "COUNT", 100)
        console.log(`  Inventory-related keys found: ${invKeys.length}`)

        if (invKeys.length > 0) {
            console.log("  Sample Redis inventory keys:")
            for (const key of invKeys.slice(0, 5)) {
                const val = await redis.get(key)
                const short = val ? val.substring(0, 120) + (val.length > 120 ? "…" : "") : "(null)"
                console.log(`    ${key}: ${short}`)
            }
        } else {
            console.log("  ℹ️  No inventory keys cached yet — Redis will re-populate on next Medusa request")
        }
    } finally {
        redis.quit()
    }
}
