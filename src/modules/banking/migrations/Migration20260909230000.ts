import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/** Persistent kill switch: one row, read by every bank lock and the sync job. Flipping it needs no redeploy. */
export class Migration20260909230000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_control (
      id text PRIMARY KEY CHECK(id='default'),
      enabled boolean NOT NULL DEFAULT true,
      reason text,
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO bank_control(id) VALUES('default') ON CONFLICT (id) DO NOTHING;`);
  }
  override async down(): Promise<void> {
    this.addSql("DROP TABLE IF EXISTS bank_control;");
  }
}
