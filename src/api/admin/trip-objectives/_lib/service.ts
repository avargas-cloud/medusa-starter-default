/**
 * src/api/admin/trip-objectives/_lib/service.ts
 *
 * Minimal typed view of the auto-generated TripObjectivesModuleService used by
 * the admin routes (the module ships full CRUD; we only type what we call).
 */

import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { TRIP_OBJECTIVES_MODULE } from "../../../../modules/trip-objectives";

export interface TripDTO {
  id: string;
  name: string;
  destination: string | null;
  timezone: string;
  status: string;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export interface CategoryDTO {
  id: string;
  trip_id: string | null;
  slug: string;
  label: string;
  icon_key: string;
  color_token: string;
  field_schema: unknown;
  status_set: unknown;
  default_status_key: string | null;
  groups: unknown;
  position: number;
  is_active: boolean;
}

export interface ObjectiveDTO {
  id: string;
  trip_id: string;
  category_id: string;
  group_id: string | null;
  title: string;
  description: string | null;
  status_key: string | null;
  priority: string;
  reference_image_url: string | null;
  reference_image_key: string | null;
  reference_image_thumb_url: string | null;
  reference_image_thumb_key: string | null;
  product_variant_id: string | null;
  product_sku: string | null;
  product_title: string | null;
  product_thumbnail_url: string | null;
  fields: Record<string, unknown> | null;
  active_optional_fields: string[] | null;
  quotes: unknown[] | null;
  metadata: Record<string, unknown> | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface ObservationDTO {
  id: string;
  objective_id: string;
  occurred_at: string;
  note: string;
  parties: unknown;
  created_at: string;
}

type ListConfig = { order?: Record<string, "ASC" | "DESC">; take?: number };

export interface TripObjectivesService {
  listTrips: (f: Record<string, unknown>, c?: ListConfig) => Promise<TripDTO[]>;
  createTrips: (d: Record<string, unknown>) => Promise<TripDTO>;

  listTripObjectiveCategories: (
    f: Record<string, unknown>,
    c?: ListConfig
  ) => Promise<CategoryDTO[]>;
  retrieveTripObjectiveCategory: (id: string) => Promise<CategoryDTO>;
  createTripObjectiveCategories: (
    d: Record<string, unknown>
  ) => Promise<CategoryDTO>;
  updateTripObjectiveCategories: (
    d: Record<string, unknown>
  ) => Promise<CategoryDTO>;
  deleteTripObjectiveCategories: (id: string) => Promise<void>;

  listTripObjectives: (
    f: Record<string, unknown>,
    c?: ListConfig
  ) => Promise<ObjectiveDTO[]>;
  retrieveTripObjective: (id: string) => Promise<ObjectiveDTO>;
  createTripObjectives: (d: Record<string, unknown>) => Promise<ObjectiveDTO>;
  updateTripObjectives: (d: Record<string, unknown>) => Promise<ObjectiveDTO>;
  deleteTripObjectives: (id: string) => Promise<void>;

  listTripObjectiveObservations: (
    f: Record<string, unknown>,
    c?: ListConfig
  ) => Promise<ObservationDTO[]>;
  createTripObjectiveObservations: (
    d: Record<string, unknown>
  ) => Promise<ObservationDTO>;
  deleteTripObjectiveObservations: (id: string) => Promise<void>;
}

export function resolveTripService(
  req: AuthenticatedMedusaRequest
): TripObjectivesService {
  return req.scope.resolve(
    TRIP_OBJECTIVES_MODULE
  ) as unknown as TripObjectivesService;
}
