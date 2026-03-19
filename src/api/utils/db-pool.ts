import { Pool } from "pg"

/**
 * Shared singleton pg.Pool for all custom admin API routes.
 *
 * WHY: Each `new Pool()` per request defaults to max:10 connections.
 * With 7+ routes doing this, we can easily hit Railway DB's connection limit,
 * causing "Connection ended unexpectedly" errors across the entire backend.
 *
 * This singleton uses max:4 connections total for ALL custom routes,
 * leaving room for MikroORM's own pool (used by Medusa native modules).
 */
let _sharedPool: Pool | null = null

export function getDbPool(): Pool {
    if (!_sharedPool) {
        const dbUrl = process.env.DATABASE_URL
        if (!dbUrl) throw new Error("DATABASE_URL is not set")

        _sharedPool = new Pool({
            connectionString: dbUrl,
            max: 4,                       // Shared across ALL custom routes
            min: 0,                       // Don't hold idle connections
            idleTimeoutMillis: 15000,     // Release idle connections before Railway drops them (~20s)
            connectionTimeoutMillis: 10000,
            ssl: dbUrl.includes("railway") || dbUrl.includes("sslmode")
                ? { rejectUnauthorized: false }
                : undefined,
        })

        _sharedPool.on("error", (err) => {
            // Non-fatal: log and allow reconnection
            console.warn("[db-pool] Idle client error (Railway dropped connection):", err.message?.slice(0, 80))
            // Force pool to recreate this connection on next use
            _sharedPool = null
        })
    }
    return _sharedPool
}
