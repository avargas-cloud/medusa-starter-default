/**
 * src/modules/places-usage/models/places-usage-daily.ts
 * One row per (day, source) counting calls to Google Places.
 *
 * Why this table exists: the address lookup is the only external, per-keystroke,
 * BILLED dependency the POS has. Its usage and — more importantly — the moment
 * Google refuses a call because the daily quota ran out lived only in Vercel's
 * logs, where nobody looks. This makes both visible in System Settings.
 *
 * **The day bucket is a PACIFIC date, not ours.** Google Cloud quotas reset at
 * midnight America/Los_Angeles, so a counter bucketed on Eastern time would
 * disagree with the quota it is supposed to track — the count would roll over
 * three hours before Google's does, and a burst in that window would look like
 * two quiet days instead of one busy one. The UI says which timezone it is.
 *
 * The counts are APPROXIMATE by design: they are written fire-and-forget from a
 * serverless route so that a slow or dead backend can never delay a cashier
 * typing an address. Google Cloud Console remains the billing truth; this is an
 * operational gauge.
 */
import { model } from "@medusajs/utils";

const PlacesUsageDaily = model.define("places_usage_daily", {
  id: model.id({ prefix: "pud" }).primaryKey(),

  /** YYYY-MM-DD in America/Los_Angeles — the timezone Google's quota resets on. */
  day: model.text(),

  /** Which app made the calls. 'web' is unused until the Astro storefront goes live. */
  source: model.enum(["pos", "web"]),

  /** Autocomplete requests (one per debounced keystroke that reached Google). */
  lookups: model.number().default(0),

  /** Place Details requests (one per address the operator actually picked). */
  details: model.number().default(0),

  /** Google refused with RESOURCE_EXHAUSTED — the daily cap was hit. */
  quota_errors: model.number().default(0),

  /** Any other upstream failure (timeout, 5xx, malformed response). */
  other_errors: model.number().default(0),

  last_error_at: model.dateTime().nullable(),
  last_error_code: model.text().nullable(),
});

export default PlacesUsageDaily;
