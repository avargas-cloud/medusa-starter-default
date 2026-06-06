#!/usr/bin/env tsx
/**
 * seed-trip-objectives.ts
 *
 * Seeds the default trip ("China Trip") + the three objective categories
 * (Sourcing / Negotiation / Decisions) with their field_schema + status_set.
 *
 * Idempotent: skips a category if its slug already exists, and skips creating
 * the trip if an active trip already exists. Safe to re-run.
 *
 * Usage:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     yarn medusa exec ./src/scripts/migrations/seed-trip-objectives.ts
 */

import { ExecArgs } from "@medusajs/framework/types";

import {
  TRIP_OBJECTIVES_MODULE,
} from "../../modules/trip-objectives";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_TRIP,
} from "../../modules/trip-objectives/defaults";

interface TripRow {
  id: string;
  is_active: boolean;
}
interface CategoryRow {
  id: string;
  slug: string;
}

export default async function seedTripObjectives({ container }: ExecArgs) {
  const logger = container.resolve("logger") as {
    info: (msg: string) => void;
  };
  const service = container.resolve(TRIP_OBJECTIVES_MODULE) as {
    listTrips: (f: Record<string, unknown>) => Promise<TripRow[]>;
    createTrips: (d: Record<string, unknown>) => Promise<TripRow>;
    listTripObjectiveCategories: (
      f: Record<string, unknown>
    ) => Promise<CategoryRow[]>;
    createTripObjectiveCategories: (
      d: Record<string, unknown>
    ) => Promise<CategoryRow>;
  };

  // ── Trip ────────────────────────────────────────────────────────────────
  const existingTrips = await service.listTrips({ is_active: true });
  let tripId: string;
  if (existingTrips.length > 0) {
    tripId = existingTrips[0].id;
    logger.info(`✔ Active trip already exists (${tripId}); skipping create.`);
  } else {
    const trip = await service.createTrips({
      ...DEFAULT_TRIP,
      status: "active",
      is_active: true,
    });
    tripId = trip.id;
    logger.info(`+ Created trip "${DEFAULT_TRIP.name}" (${tripId}).`);
  }

  // ── Categories ──────────────────────────────────────────────────────────
  const existingCats = await service.listTripObjectiveCategories({});
  const existingSlugs = new Set(existingCats.map((c) => c.slug));

  for (const cat of DEFAULT_CATEGORIES) {
    if (existingSlugs.has(cat.slug)) {
      logger.info(`✔ Category "${cat.slug}" exists; skipping.`);
      continue;
    }
    await service.createTripObjectiveCategories({
      slug: cat.slug,
      label: cat.label,
      icon_key: cat.icon_key,
      color_token: cat.color_token,
      position: cat.position,
      field_schema: cat.field_schema,
      status_set: cat.status_set,
      default_status_key: cat.default_status_key,
      is_active: true,
    });
    logger.info(
      `+ Created category "${cat.label}" (${cat.field_schema.length} fields, ${cat.status_set.length} statuses).`
    );
  }

  logger.info("✅ Trip-objectives seed complete.");
}
