import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Hardening for qb_item_pipeline after the seq-120 / LUX-LR24950 infinite-mod
 * incident (2026-05-29).
 *
 * Root cause was twofold:
 *  1. Recovery markers (__iq_pending / __iq_reconcile) lived inside the
 *     `op_payload` JSONB column. Medusa's service update DEEP-MERGES jsonb, so a
 *     deleted key is re-hydrated from the stored value and never disappears →
 *     the marker became immortal and Phase A re-ran the recovery branch forever.
 *  2. The only loop guard (`retries`) increments solely on resubmit *failure*.
 *     A resubmit that *succeeds* every tick but never completes keeps retries=0,
 *     so the loop was invisible to every safety net (and to the updated_at-based
 *     stale-cleanup, since each tick refreshed updated_at).
 *
 * This migration:
 *  - Moves recovery state OUT of the JSONB into a scalar `recovery_mode` column
 *    (a scalar update has no merge ambiguity — it always replaces).
 *  - Adds `submit_count` / `last_submitted_at` so an actively-looping row (which
 *    keeps updated_at fresh) is still detectable, and a hard submit cap can fire.
 *  - Adds `last_error_code` for structured error triage.
 *  - Backfills `recovery_mode` from any existing in-flight JSONB markers so the
 *    new poller picks up mid-recovery rows correctly after deploy.
 */
export class Migration20260529221500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "qb_item_pipeline" add column if not exists "submit_count" integer not null default 0;`
    );
    this.addSql(
      `alter table "qb_item_pipeline" add column if not exists "last_submitted_at" timestamptz null;`
    );
    this.addSql(
      `alter table "qb_item_pipeline" add column if not exists "last_error_code" text null;`
    );
    this.addSql(
      `alter table "qb_item_pipeline" add column if not exists "recovery_mode" text not null default 'none';`
    );
    this.addSql(
      `alter table "qb_item_pipeline" drop constraint if exists "qb_item_pipeline_recovery_mode_check";`
    );
    this.addSql(
      `alter table "qb_item_pipeline" add constraint "qb_item_pipeline_recovery_mode_check" check ("recovery_mode" in ('none', 'editseq_query', 'reconcile_query'));`
    );

    // Backfill recovery_mode from any surviving JSONB markers on in-flight rows.
    // __iq_reconcile and __iq_pending are mutually exclusive; reconcile wins if
    // (illegally) both are truthy, matching the poller's branch order. Use a TEXT
    // comparison (= 'true'), not ::boolean, so a legacy non-boolean value can't
    // abort the migration with a cast error.
    this.addSql(
      `update "qb_item_pipeline"
         set "recovery_mode" = case
             when (op_payload->>'__iq_reconcile') = 'true' then 'reconcile_query'
             when (op_payload->>'__iq_pending')   = 'true' then 'editseq_query'
             else 'none'
           end
       where op_payload is not null
         and ( (op_payload->>'__iq_reconcile') = 'true'
            or (op_payload->>'__iq_pending')   = 'true' );`
    );

    // Now that recovery state is captured in the scalar column, physically REMOVE
    // the legacy markers from op_payload via raw SQL (the `-` operator replaces the
    // whole jsonb value — unlike the service update, which deep-merges and could
    // never delete a key; that merge is the root of the seq-120 incident). After
    // this, the loop-audit's "legacy markers = 0" invariant holds.
    this.addSql(
      `update "qb_item_pipeline"
         set "op_payload" = ("op_payload" - '__iq_pending' - '__iq_reconcile')
       where op_payload is not null
         and ( op_payload ? '__iq_pending' or op_payload ? '__iq_reconcile' );`
    );

    // Seed submit_count for existing rows so loop history is approximated (at least
    // 1 for any already-dispatched row). Conservative: a missed count only delays
    // the cap by a few ticks, it never causes a false-positive demotion.
    this.addSql(
      `update "qb_item_pipeline"
         set "submit_count" = greatest(coalesce("retries", 0), 1)
       where "qb_operation_id" is not null or "status" <> 'waiting';`
    );

    this.addSql(
      `create index if not exists "IDX_qb_item_pipeline_recovery_mode" on "qb_item_pipeline" ("recovery_mode") where deleted_at is null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `drop index if exists "IDX_qb_item_pipeline_recovery_mode";`
    );
    this.addSql(
      `alter table "qb_item_pipeline" drop constraint if exists "qb_item_pipeline_recovery_mode_check";`
    );
    this.addSql(
      `alter table "qb_item_pipeline" drop column if exists "recovery_mode";`
    );
    this.addSql(
      `alter table "qb_item_pipeline" drop column if exists "last_error_code";`
    );
    this.addSql(
      `alter table "qb_item_pipeline" drop column if exists "last_submitted_at";`
    );
    this.addSql(
      `alter table "qb_item_pipeline" drop column if exists "submit_count";`
    );
  }
}
