import type { MedusaContainer } from "@medusajs/framework/types";

import { materializeAll } from "../lib/calendar/recurring-repo";
import { getBusinessDateString } from "../lib/date/et";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

/**
 * src/jobs/recurring-expenses-materialize.ts
 *
 * Una vez por día (07:10 UTC ≈ 03:10 ET) inserta los vencimientos de las
 * reglas activas hasta 90 días adelante. Idempotente por `uq_rexo_rule_period`;
 * el save de una regla ya materializa, así que este job es la red para el
 * horizonte que avanza solo. Nunca escribe documentos ni QB.
 */
export default async function recurringExpensesMaterialize(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  try {
    const r = await materializeAll(pg, getBusinessDateString());
    logger.info(`[recurring-expenses] materialized ${r.inserted} occurrence(s) across ${r.rules} active rule(s)`);
  } catch (err: unknown) {
    logger.error(`[recurring-expenses] materialize failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = { name: "recurring-expenses-materialize", schedule: "10 7 * * *" };
