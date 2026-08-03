import type { MedusaContainer } from "@medusajs/framework/types";
import { Client } from "pg";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

export default async function orderCompletionAuditPurge(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve("logger") as {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  const retention = Number(
    process.env.ORDER_COMPLETION_AUDIT_RETENTION_DAYS ?? 30
  );
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
    logger.warn(
      `[order-completion-audit-purge] invalid retention: ${retention}`
    );
    return;
  }

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    const deleted = await db.query(
      `DELETE FROM order_completion_attempt
        WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [retention]
    );
    if ((deleted.rowCount ?? 0) > 0) {
      logger.info(
        `[order-completion-audit-purge] deleted=${deleted.rowCount} retention_days=${retention}`
      );
    }
  } catch (error: unknown) {
    logger.warn(
      `[order-completion-audit-purge] failed: ${(error as Error).message}`
    );
  } finally {
    await db.end().catch(() => undefined);
  }
}

export const config = {
  name: "order-completion-audit-purge",
  schedule: "25 4 * * *",
};
