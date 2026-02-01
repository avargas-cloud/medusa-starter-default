import { Migration } from "@mikro-orm/migrations"

export class Migration20260201175200 extends Migration {
    async up(): Promise<void> {
        // Add legacy_customer flag to all guest customers with QuickBooks ID
        this.addSql(`
            UPDATE customer
            SET metadata = metadata || '{"legacy_customer": true}'::jsonb
            WHERE has_account = false
              AND metadata->>'qb_list_id' IS NOT NULL;
        `)
    }

    async down(): Promise<void> {
        // Remove legacy_customer flag
        this.addSql(`
            UPDATE customer
            SET metadata = metadata - 'legacy_customer'
            WHERE metadata->>'legacy_customer' = 'true';
        `)
    }
}
