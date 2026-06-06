#!/usr/bin/env tsx
/**
 * backfill-trip-objective-defaults.ts
 *
 * Idempotently merges any NEW default fields/groups into the existing
 * categories (matched by slug) WITHOUT clobbering user customizations. Adds a
 * default field/group only when its key/id is missing. Use after adding fields
 * to defaults.ts (e.g. the Negotiation "speech" field).
 *
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     yarn medusa exec ./src/scripts/migrations/backfill-trip-objective-defaults.ts
 *
 * Safe to re-run.
 */

import { ExecArgs } from "@medusajs/framework/types";
import { TRIP_OBJECTIVES_MODULE } from "../../modules/trip-objectives";
import { DEFAULT_CATEGORIES } from "../../modules/trip-objectives/defaults";

interface Keyed {
  key?: string;
  id?: string;
}

export default async function backfill({ container }: ExecArgs) {
  const logger = container.resolve("logger") as { info: (m: string) => void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = container.resolve(TRIP_OBJECTIVES_MODULE) as any;

  for (const def of DEFAULT_CATEGORIES) {
    const [cat] = await svc.listTripObjectiveCategories({ slug: def.slug });
    if (!cat) {
      logger.info(`✔ ${def.slug}: not present, skipping (run the seed first).`);
      continue;
    }

    const existingFields = (cat.field_schema ?? []) as Keyed[];
    const existingFieldKeys = new Set(existingFields.map((f) => f.key));
    const missingFields = def.field_schema.filter(
      (f) => !existingFieldKeys.has(f.key)
    );

    const existingGroups = (cat.groups ?? []) as Keyed[];
    const existingGroupIds = new Set(existingGroups.map((g) => g.id));
    const missingGroups = (def.groups ?? []).filter(
      (g) => !existingGroupIds.has(g.id)
    );

    if (missingFields.length === 0 && missingGroups.length === 0) {
      logger.info(`✔ ${def.slug}: up to date.`);
      continue;
    }

    await svc.updateTripObjectiveCategories({
      id: cat.id,
      field_schema: [...existingFields, ...missingFields],
      groups: [...existingGroups, ...missingGroups],
    });
    logger.info(
      `+ ${def.slug}: added ${missingFields.length} field(s) [${missingFields
        .map((f) => f.key)
        .join(", ")}], ${missingGroups.length} group(s).`
    );
  }

  logger.info("✅ Trip-objective defaults backfill complete.");
}
