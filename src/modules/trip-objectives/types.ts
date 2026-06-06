/**
 * src/modules/trip-objectives/types.ts
 *
 * Shared shapes for the China-trip objective tracker. The `FieldDef` /
 * `StatusDef` contracts are the single source of truth for the dynamic,
 * per-category field schema + status set. The store-pos frontend mirrors
 * these types so the form renderer and the visual field builder agree on
 * the JSON shape persisted in `trip_objective_category.field_schema` /
 * `status_set` and `trip_objective.fields`.
 */

/** Input control rendered for a field. */
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "percent"
  | "select"
  | "multiselect"
  | "date"
  | "boolean"
  | "product_link";

/**
 * One field in a category's schema. `optional` fields are NOT shown by
 * default on an objective — the user adds them per-entry ("seleccionable"),
 * which is how lighting specs (lumens, watts, input/output voltage, …) work:
 * a product only fills the specs that apply to it.
 */
/**
 * Where a field lives:
 *   "objective" → entered once on the entry (the sourcing target).
 *   "quote"     → repeats per result/quote (a sourcing objective can hold
 *                 several supplier quotes — even multiple from one supplier).
 * Defaults to "objective" when omitted.
 */
export type FieldScope = "objective" | "quote";

export interface FieldDef {
  /** Stable machine key, e.g. "target_price". Never change once data exists. */
  key: string;
  label: string;
  type: FieldType;
  /** Section grouping for the form, e.g. "Pricing", "Specs". */
  group?: string;
  /** Choices for select / multiselect. */
  options?: string[];
  /** Display unit suffix, e.g. "lm", "W", "V", "days", "lm/ft". */
  unit?: string;
  placeholder?: string;
  /** Optional/addable spec field — hidden until the user enables it per entry. */
  optional?: boolean;
  /** Objective-level (default) or per-quote. */
  scope?: FieldScope;
  /** Ordering within the schema (and within its group). */
  position: number;
}

/**
 * One result/quote under a sourcing objective. `fields` is keyed by the
 * category's quote-scoped FieldDefs. Each quote can carry its own photo and be
 * flagged as the preferred option. Multiple quotes may share a supplier.
 */
export interface ObjectiveQuote {
  /** Client-generated stable id (e.g. "q_" + random). */
  id: string;
  reference_image_url?: string | null;
  reference_image_key?: string | null;
  reference_image_thumb_url?: string | null;
  reference_image_thumb_key?: string | null;
  is_preferred?: boolean;
  fields?: ObjectiveFieldValues;
  active_optional_fields?: string[];
  position?: number;
}

/** A user-defined sub-group to organize entries within a type. */
export interface ObjectiveGroup {
  id: string;
  label: string;
  position: number;
}

/** One status option in a category's pipeline. */
export interface StatusDef {
  key: string;
  label: string;
  /** Tailwind-ish color token resolved by the frontend (e.g. "emerald"). */
  color?: string;
  /** Terminal states (achieved / rejected / decided / walked-away). */
  terminal?: boolean;
  position: number;
}

/** Persisted value bag on an objective, keyed by FieldDef.key. */
export type ObjectiveFieldValues = Record<
  string,
  string | number | boolean | string[] | null
>;

/** Default timezone for a China trip — observations group by trip-local day. */
export const DEFAULT_TRIP_TIMEZONE = "Asia/Shanghai";

/** Allowed MIME types for reference images (no HEIC — canvas can't resize it). */
export const ALLOWED_IMAGE_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
