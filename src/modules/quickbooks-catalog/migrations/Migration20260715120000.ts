import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * The QB Pipeline error digest's "STUCK" bucket (non-terminal rows older than
 * 2h — resubmit loops) had no memory of what it already told the user: it
 * re-surfaced the SAME still-broken row in every daily digest forever, since
 * the only age signal (`created_at`) never resets even after a manual Retry
 * (which resets status/retries/next_retry_at but not created_at).
 *
 * `digest_notified_at` lets the digest job stamp a row once it has reported
 * it, then stay quiet about that exact incident unless (a) something new
 * happened (a retry attempt bumped `updated_at` past the last notification),
 * or (b) a week has passed with total silence (safety-net reminder so a
 * truly-frozen row doesn't fall off the radar forever).
 */
export class Migration20260715120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "qb_item_pipeline" add column if not exists "digest_notified_at" timestamptz null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "qb_item_pipeline" drop column if exists "digest_notified_at";`
    );
  }
}
