import { Migration } from '@mikro-orm/migrations'

/**
 * Adds shipping_address JSONB column to pos_invoice.
 * Each invoice now stores a snapshot of the order's shipping address at the
 * moment it was created — independent of future changes to the order.
 */
export class Migration20260312204500 extends Migration {
    async up(): Promise<void> {
        await this.execute(`
            ALTER TABLE pos_invoice
            ADD COLUMN IF NOT EXISTS shipping_address jsonb;
        `)
    }

    async down(): Promise<void> {
        await this.execute(`
            ALTER TABLE pos_invoice
            DROP COLUMN IF EXISTS shipping_address;
        `)
    }
}
