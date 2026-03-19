import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/utils"
import { reconcileCustomersCore } from "../../../src/lib/quickbooks/reconcile-customers-core"

export default async function liveRunReconcile({ container }: ExecArgs) {
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    logger.info("=========================================")
    logger.info("🚀 STARTING LIVE CUSTOMER ID RECONCILIATION")
    logger.info("=========================================")

    const result = await reconcileCustomersCore(container, {
        dryRun: false
    })

    if (result.success) {
        logger.info(`✅ Script completed successfully!`)
    } else {
        logger.error(`❌ Script failed: ${result.error}`)
    }
}
