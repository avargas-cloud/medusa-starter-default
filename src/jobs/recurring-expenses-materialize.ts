import type { MedusaContainer } from "@medusajs/framework/types";

import { adoptExistingDocuments } from "../lib/calendar/occurrence-adopt";
import { addDays } from "../lib/calendar/recurring-occurrences";
import { MATERIALIZE_HORIZON_DAYS, materializeAll } from "../lib/calendar/recurring-repo";
import { getBusinessDateString } from "../lib/date/et";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

/**
 * src/jobs/recurring-expenses-materialize.ts
 *
 * Una vez por día (07:10 UTC ≈ 03:10 ET) inserta los vencimientos de las
 * reglas activas hasta 90 días adelante. Idempotente por `uq_rexo_rule_period`;
 * el save de una regla ya materializa, así que este job es la red para el
 * horizonte que avanza solo. Después ADOPTA los documentos que evidentemente
 * son una ocurrencia (candidato único: `occurrence-adopt.ts`). Nunca escribe
 * documentos ni QB.
 */
export default async function recurringExpensesMaterialize(container: MedusaContainer): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  const logger = container.resolve("logger");
  const pg = container.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
  try {
    const today = getBusinessDateString();
    const r = await materializeAll(pg, today);
    logger.info(`[recurring-expenses] materialized ${r.inserted} occurrence(s) across ${r.rules} active rule(s)`);
    const a = await adoptExistingDocuments(pg, `${today.slice(0, 7)}-01`, addDays(today, MATERIALIZE_HORIZON_DAYS), { actorId: "job:adopt" });
    logger.info(`[recurring-expenses] adopted ${a.adopted.length} document(s); ${a.ambiguous.length} ambiguous of ${a.scanned} expected`);
  } catch (err: unknown) {
    logger.error(`[recurring-expenses] materialize failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const config = { name: "recurring-expenses-materialize", schedule: "10 7 * * *" };
