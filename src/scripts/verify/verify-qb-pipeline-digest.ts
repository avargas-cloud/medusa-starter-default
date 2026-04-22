/**
 * verify-qb-pipeline-digest.ts
 *
 * Manually fires the qb-pipeline-error-digest cron handler against REAL pipeline
 * data so you can see the actual email today (instead of waiting for 8 AM EDT).
 *
 * Sends a real email via Resend to QB_PIPELINE_DIGEST_TO. Reads only — does
 * NOT mutate any pipeline rows or insert anything to the DB.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/verify/verify-qb-pipeline-digest.ts
 */

import type { ExecArgs } from "@medusajs/framework/types";

import qbPipelineErrorDigest from "../../jobs/qb-pipeline-error-digest";

export default async function main({ container }: ExecArgs) {
  const logger = container.resolve("logger");

  logger.info("[verify-qb-pipeline-digest] firing digest against real data...");
  logger.info(
    `  → recipient: ${process.env.QB_PIPELINE_DIGEST_TO || "a.vargas@ecopowertech.com"}`
  );
  logger.info(
    `  → resend key: ${process.env.RESEND_API_KEY ? "configured" : "MISSING (will skip send)"}`
  );

  await qbPipelineErrorDigest(container);

  logger.info(
    "[verify-qb-pipeline-digest] done. Check your inbox (and spam folder) — " +
      "the cron skips send when zero errors across all 4 pipelines."
  );
}
