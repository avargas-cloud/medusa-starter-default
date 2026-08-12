/**
 * Runs the reservation-drift digest section collector once and prints its
 * result — the same function the nightly digest calls, not a copy of its SQL.
 * Read-only. Usage:
 *   env DATABASE_URL=... ./node_modules/.bin/medusa exec ./src/scripts/debug/run-reservation-drift-section-once.ts
 */
import { ContainerRegistrationKeys } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { collectReservationDriftSection } from "../../jobs/_lib/_reservation-drift-section";

export default async function runReservationDriftSectionOnce({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
  const section = await collectReservationDriftSection(knex, logger);
  if (!section) {
    logger.info("[reservation-drift] clean — no cache drift, no poisoned counters");
    return;
  }
  logger.info(`[reservation-drift] ${section.rows.length} row(s):`);
  for (const r of section.rows) {
    logger.info(`  [${r.status}] ${r.medusa_ref} — ${r.error}`);
  }
}
