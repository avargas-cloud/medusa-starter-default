import { Migration } from "@mikro-orm/migrations"

export class Migration20260201170300 extends Migration {
    async up(): Promise<void> {
        // Allow NULL values for sync intervals to support disabling syncs
        this.addSql(`
            ALTER TABLE "quickbooks_config"
            ALTER COLUMN "inventory_interval_minutes" DROP NOT NULL,
            ALTER COLUMN "price_interval_minutes" DROP NOT NULL;
        `)
    }

    async down(): Promise<void> {
        // Restore NOT NULL constraints
        this.addSql(`
            ALTER TABLE "quickbooks_config"
            ALTER COLUMN "inventory_interval_minutes" SET NOT NULL,
            ALTER COLUMN "price_interval_minutes" SET NOT NULL;
        `)
    }
}
