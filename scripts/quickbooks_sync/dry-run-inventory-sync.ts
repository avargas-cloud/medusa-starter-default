import { ExecArgs } from "@medusajs/framework/types"
import { syncInventoryCore } from "../../lib/quickbooks/sync-inventory-core"

/**
 * Dry-run inventory sync — polls QB Bridge, compares to Medusa, shows preview.
 *
 * Usage:
 *   npx medusa exec src/scripts/sync/dry-run-inventory-sync.ts
 *
 * ⚠️  This polls the QB Bridge (takes ~2-5 min while the Web Connector processes).
 *     Nothing is written to Medusa.
 *
 * Output:
 *   - Table of SKUs that would change (current → new, delta)
 *   - Anomaly list (huge drops, going to 0)
 *   - Items in QB with no Medusa match
 *   - Items in Medusa not found in QB
 */
export default async function dryRunInventorySync({ container }: ExecArgs) {
    const { ContainerRegistrationKeys } = await import("@medusajs/framework/utils")
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    logger.info("=".repeat(60))
    logger.info("🔍 INVENTORY SYNC — DRY RUN")
    logger.info("Polling QB Bridge... this may take 2-5 minutes.")
    logger.info("=".repeat(60))

    const result = await syncInventoryCore(container, { dryRun: true })

    if (!result.success) {
        logger.error(`\n❌ Dry run failed: ${result.error}`)
        return
    }

    const preview = result.preview ?? []
    const anomalies = result.anomalies ?? []

    // ─── Main preview table ────────────────────────────────────────────────
    if (preview.length === 0) {
        logger.info("\n✅ No stock changes needed — Medusa is already in sync with QB.")
    } else {
        logger.info(`\n📋 STOCK CHANGES PREVIEW (${preview.length} SKUs would update):\n`)
        logger.info("   SKU                  Current  →   QB     Delta  Flag")
        logger.info("   " + "-".repeat(58))

        // Sort: anomalies first, then by delta magnitude
        const sorted = [...preview].sort((a, b) => {
            if (a.isAnomaly !== b.isAnomaly) return a.isAnomaly ? -1 : 1
            return Math.abs(b.delta) - Math.abs(a.delta)
        })

        sorted.forEach(item => {
            const flag = item.isAnomaly ? "⚠️  ANOMALY" : item.delta > 0 ? "▲ increase" : "▼ decrease"
            const deltaStr = (item.delta > 0 ? "+" : "") + item.delta
            logger.info(
                `   ${item.sku.padEnd(20)}  ${String(item.currentStock).padStart(7)}  → ${String(item.newStock).padStart(5)}  ${deltaStr.padStart(7)}  ${flag}`
            )
            if (item.isAnomaly && item.anomalyReason) {
                logger.info(`   ${"".padEnd(20)}  └─ ${item.anomalyReason}`)
            }
        })
    }

    // ─── Anomaly summary ──────────────────────────────────────────────────
    if (anomalies.length > 0) {
        logger.info(`\n${"⚠️  ".repeat(10)}`)
        logger.info(`⚠️  ${anomalies.length} ANOMALIES DETECTED — review carefully before running live sync:`)
        anomalies.forEach(a => {
            logger.info(`   • ${a.sku}: ${a.anomalyReason}`)
        })
        logger.info(`${"⚠️  ".repeat(10)}`)
        logger.info("\n   To proceed with the live sync anyway:")
        logger.info("   curl -s -X POST http://localhost:9000/admin/quickbooks/sync/inventory \\")
        logger.info("     -H 'Content-Type: application/json' \\")
        logger.info("     -b path/to/cookies.txt")
    } else if (preview.length > 0) {
        logger.info("\n✅ No anomalies detected. Safe to proceed with live sync.")
        logger.info("\n   To run live sync:")
        logger.info("   curl -s -X POST http://localhost:9000/admin/quickbooks/sync/inventory \\")
        logger.info("     -H 'Content-Type: application/json' \\")
        logger.info("     -b path/to/cookies.txt")
    }

    // ─── Discrepancy report ───────────────────────────────────────────────
    const { onlyInQb = [], onlyInMedusa = [] } = result.discrepancyReport ?? {}

    if (onlyInQb.length > 0) {
        logger.info(`\n📦 ${onlyInQb.length} QB items have no Medusa match (not on website, will be ignored):`)
        onlyInQb.slice(0, 10).forEach(name => logger.info(`   • ${name}`))
        if (onlyInQb.length > 10) logger.info(`   ... and ${onlyInQb.length - 10} more`)
    }

    if (onlyInMedusa.length > 0) {
        logger.info(`\n🛒 ${onlyInMedusa.length} Medusa variants NOT found in QB response (stock won't update):`)
        onlyInMedusa.slice(0, 10).forEach(sku => logger.info(`   • ${sku}`))
        if (onlyInMedusa.length > 10) logger.info(`   ... and ${onlyInMedusa.length - 10} more`)
    }

    // ─── Stats summary ────────────────────────────────────────────────────
    logger.info("\n" + "=".repeat(60))
    logger.info("📊 STATS SUMMARY")
    logger.info("-".repeat(30))
    logger.info(`   Linked to QB:         ${result.stats.totalLinkedVariants}`)
    logger.info(`   Found in QB:          ${result.stats.foundInQb}`)
    logger.info(`   Missing in QB:        ${result.stats.missingInQb}`)
    logger.info(`   Would update:         ${result.stats.wouldUpdate ?? 0}`)
    logger.info(`   No change needed:     ${result.stats.skippedNoChange ?? 0}`)
    logger.info(`   No inventory item:    ${result.stats.skippedNoInventoryItem}`)
    logger.info(`   Anomalies:            ${anomalies.length}`)
    logger.info("=".repeat(60))
}
