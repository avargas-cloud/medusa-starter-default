import { Migration } from "@mikro-orm/migrations";

export class Migration20260201171800 extends Migration {
  async up(): Promise<void> {
    // Create customer audit table for storing QB vs Medusa comparison results
    this.addSql(`
            CREATE TABLE IF NOT EXISTS "quickbooks_customer_audit" (
                "id" TEXT PRIMARY KEY DEFAULT 'latest',
                "total_in_qb" INTEGER NOT NULL DEFAULT 0,
                "total_in_medusa" INTEGER NOT NULL DEFAULT 0,
                "only_in_qb" INTEGER NOT NULL DEFAULT 0,
                "only_in_medusa" INTEGER NOT NULL DEFAULT 0,
                "in_both" INTEGER NOT NULL DEFAULT 0,
                "customers_only_in_qb" JSONB,
                "customers_only_in_medusa" JSONB,
                "last_check_at" TIMESTAMPTZ DEFAULT NOW(),
                "created_at" TIMESTAMPTZ DEFAULT NOW()
            );
        `);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "quickbooks_customer_audit";`);
  }
}
