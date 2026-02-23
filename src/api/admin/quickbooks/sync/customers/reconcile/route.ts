import { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { reconcileCustomersCore } from "../../../../../lib/quickbooks/reconcile-customers-core"
import { createJob, updateJob, completeJob, failJob } from "../../../../../lib/quickbooks/sync-jobs"

/**
 * Executes the Customer ID Reconciliation process as an async Job (Server-Sent Events).
 * 
 * Supports dry_run mode to preview matches without changing Medusa DB.
 */
export async function POST(
    req: AuthenticatedMedusaRequest,
    res: MedusaResponse
) {
    const { dry_run = false } = req.body as { dry_run?: boolean }

    const jobId = createJob(
        dry_run ? "customer_reconcile_dry" : "customer_reconcile",
        `Started Customer Reconciliation (Dry Run: ${dry_run})...`
    )

        // Fire and forget
        ; (async () => {
            try {
                updateJob(jobId, "Initializing Quickbooks Bridge Connection...")

                const result = await reconcileCustomersCore(req.scope, {
                    dryRun: dry_run,
                    onLog: (msg) => {
                        updateJob(jobId, msg)
                    }
                })

                if (result.success) {
                    completeJob(jobId, result)
                } else {
                    failJob(jobId, result.error || "Unknown reconciliation error")
                }
            } catch (error: any) {
                failJob(jobId, error.message)
            }
        })()

    res.json({ success: true, job_id: jobId })
}
