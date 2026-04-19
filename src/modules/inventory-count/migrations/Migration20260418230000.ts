import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260418230000
 *
 * Adds void support to inventory counts:
 *   - 'voided' added to the inventory_count.status CHECK constraint
 *   - voided_at / voided_by_user_id / void_reason columns on inventory_count
 *   - 'voided' added to the inventory_count_line.status CHECK constraint
 *   - void_status / void_operation_id / void_synced_at / void_last_error /
 *     void_retries / void_next_retry_at columns on qb_inventory_adjustment_pipeline
 *
 * Void semantics: previously-approved counts can be voided. Void contra-applies
 * the stock delta in Medusa and emits a TxnVoidRq for InventoryAdjustment in
 * QuickBooks (QB sets all line QtyDifferences to 0 + prefixes Memo with "VOID:",
 * preserving the audit trail).
 */
export class Migration20260418230000 extends Migration {
  override async up(): Promise<void> {
    // inventory_count: status enum + void columns
    this.addSql(
      `alter table "inventory_count" drop constraint if exists "inventory_count_status_check";`
    );
    this.addSql(
      `alter table "inventory_count" add constraint "inventory_count_status_check" check ("status" in ('draft','submitted','approved','partially_applied','rejected','cancelled','voided'));`
    );
    this.addSql(
      `alter table "inventory_count" add column if not exists "voided_at" timestamptz null;`
    );
    this.addSql(
      `alter table "inventory_count" add column if not exists "voided_by_user_id" text null;`
    );
    this.addSql(
      `alter table "inventory_count" add column if not exists "void_reason" text null;`
    );

    // inventory_count_line: status enum
    this.addSql(
      `alter table "inventory_count_line" drop constraint if exists "inventory_count_line_status_check";`
    );
    this.addSql(
      `alter table "inventory_count_line" add constraint "inventory_count_line_status_check" check ("status" in ('pending','applied','blocked','skipped','overridden','verified','voided'));`
    );

    // qb_inventory_adjustment_pipeline: void columns
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" add column if not exists "void_status" text null;`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" add column if not exists "void_operation_id" text null;`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" add column if not exists "void_synced_at" timestamptz null;`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" add column if not exists "void_last_error" text null;`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" add column if not exists "void_retries" integer not null default 0;`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" add column if not exists "void_next_retry_at" timestamptz null;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" drop column if exists "void_next_retry_at";`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" drop column if exists "void_retries";`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" drop column if exists "void_last_error";`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" drop column if exists "void_synced_at";`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" drop column if exists "void_operation_id";`
    );
    this.addSql(
      `alter table "qb_inventory_adjustment_pipeline" drop column if exists "void_status";`
    );
    this.addSql(
      `alter table "inventory_count_line" drop constraint if exists "inventory_count_line_status_check";`
    );
    this.addSql(
      `alter table "inventory_count_line" add constraint "inventory_count_line_status_check" check ("status" in ('pending','applied','blocked','skipped','overridden','verified'));`
    );
    this.addSql(
      `alter table "inventory_count" drop column if exists "void_reason";`
    );
    this.addSql(
      `alter table "inventory_count" drop column if exists "voided_by_user_id";`
    );
    this.addSql(
      `alter table "inventory_count" drop column if exists "voided_at";`
    );
    this.addSql(
      `alter table "inventory_count" drop constraint if exists "inventory_count_status_check";`
    );
    this.addSql(
      `alter table "inventory_count" add constraint "inventory_count_status_check" check ("status" in ('draft','submitted','approved','partially_applied','rejected','cancelled'));`
    );
  }
}
