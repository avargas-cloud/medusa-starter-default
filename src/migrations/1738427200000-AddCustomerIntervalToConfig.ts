import { Migration } from "@mikro-orm/migrations"

export class Migration20260201172000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "quickbooks_config"
            ADD COLUMN IF NOT EXISTS "customer_interval_minutes" INTEGER;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            ALTER TABLE "quickbooks_config"
            DROP COLUMN IF EXISTS "customer_interval_minutes";
        `)
    }
}
