/**
 * src/modules/places-usage/service.ts
 * Counting and reading Google Places usage.
 *
 * Both operations go through raw SQL rather than the generated CRUD:
 *
 *  - `record()` must be an ATOMIC increment. Several cashiers type addresses at
 *    the same time, and a read-modify-write through the module service would
 *    lose counts under concurrency. `INSERT … ON CONFLICT DO UPDATE` with the
 *    increment expressed in SQL cannot.
 *  - `summary()` aggregates across rows, which the generated list API would make
 *    into an N-row round trip for no reason.
 *
 * knex placeholders are `?` (the pg pool uses `$1` — they are NOT interchangeable;
 * see the repo-wide rule in CLAUDE.md).
 */
import { MedusaService } from "@medusajs/utils";
import type Knex from "knex";

import PlacesUsageDaily from "./models/places-usage-daily";

export type PlacesUsageSource = "pos" | "web";
export type PlacesUsageKind = "lookup" | "details" | "quota_error" | "other_error";

const COLUMN_FOR: Record<PlacesUsageKind, string> = {
  lookup: "lookups",
  details: "details",
  quota_error: "quota_errors",
  other_error: "other_errors",
};

export interface PlacesUsageRow {
  source: PlacesUsageSource;
  lookups: number;
  details: number;
  quota_errors: number;
  other_errors: number;
  last_error_at: string | null;
  last_error_code: string | null;
}

export interface PlacesUsageSummary {
  /** The Pacific date the "today" figures cover, as YYYY-MM-DD. */
  day: string;
  /** Google Cloud quotas reset at midnight in this zone — surfaced so the UI can say so. */
  timezone: "America/Los_Angeles";
  today: PlacesUsageRow[];
  month: PlacesUsageRow[];
  daily_quota: number;
  monthly_free_tier: number;
}

interface Deps {
  __pg_connection__: Knex.Knex;
}

/**
 * This is the first module in the repo that both extends `MedusaService` and
 * reaches for the raw connection, so there was no in-house pattern to copy:
 * `pos-tax` takes the container but extends nothing, `ground-shipping` takes it
 * but extends a provider base class. The container is forwarded to `super` and
 * the connection pulled off it — no cast, so `type-check` actually verifies it.
 */
class PlacesUsageModuleService extends MedusaService({ PlacesUsageDaily }) {
  private readonly knex: Knex.Knex;

  constructor(container: Deps) {
    super(container);
    this.knex = container.__pg_connection__;
  }

  /**
   * The Pacific calendar date. Computed with Intl rather than by subtracting
   * hours: Pacific is UTC-8 or UTC-7 depending on daylight saving, and a
   * hardcoded offset silently mis-buckets half the year.
   */
  static pacificDay(now: Date = new Date()): string {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now); // en-CA formats as YYYY-MM-DD
  }

  /**
   * Atomically add one event. Never throws for a caller that does not care —
   * callers are fire-and-forget proxies, and a counting failure must never
   * become a user-visible failure.
   */
  async record(
    source: PlacesUsageSource,
    kind: PlacesUsageKind,
    errorCode?: string
  ): Promise<void> {
    const column = COLUMN_FOR[kind];
    if (!column) return;

    const day = PlacesUsageModuleService.pacificDay();
    const isError = kind === "quota_error" || kind === "other_error";

    await this.knex.raw(
      `
      insert into "places_usage_daily"
        ("id", "day", "source", "${column}", "last_error_at", "last_error_code", "created_at", "updated_at")
      values
        (?, ?, ?, 1, ${isError ? "now()" : "null"}, ${isError ? "?" : "null"}, now(), now())
      on conflict ("day", "source") do update set
        "${column}"      = "places_usage_daily"."${column}" + 1,
        ${isError ? `"last_error_at" = now(), "last_error_code" = excluded."last_error_code",` : ""}
        "updated_at"     = now()
      `,
      isError
        ? [`pud_${day}_${source}`, day, source, errorCode ?? "unknown"]
        : [`pud_${day}_${source}`, day, source]
    );
  }

  async summary(dailyQuota: number, monthlyFreeTier: number): Promise<PlacesUsageSummary> {
    const day = PlacesUsageModuleService.pacificDay();
    const monthPrefix = day.slice(0, 7); // YYYY-MM

    const select = `
      "source",
      coalesce(sum("lookups"), 0)::int      as "lookups",
      coalesce(sum("details"), 0)::int      as "details",
      coalesce(sum("quota_errors"), 0)::int as "quota_errors",
      coalesce(sum("other_errors"), 0)::int as "other_errors",
      max("last_error_at")                  as "last_error_at",
      (array_remove(array_agg("last_error_code" order by "last_error_at" desc nulls last), null))[1] as "last_error_code"
    `;

    const [todayRes, monthRes] = await Promise.all([
      this.knex.raw(
        `select ${select} from "places_usage_daily" where "day" = ? group by "source"`,
        [day]
      ),
      this.knex.raw(
        `select ${select} from "places_usage_daily" where "day" like ? group by "source"`,
        [`${monthPrefix}%`]
      ),
    ]);

    const rows = (res: { rows?: PlacesUsageRow[] }): PlacesUsageRow[] => res.rows ?? [];

    return {
      day,
      timezone: "America/Los_Angeles",
      today: rows(todayRes),
      month: rows(monthRes),
      daily_quota: dailyQuota,
      monthly_free_tier: monthlyFreeTier,
    };
  }
}

export default PlacesUsageModuleService;
