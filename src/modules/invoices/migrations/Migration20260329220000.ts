import { Migration } from '@mikro-orm/migrations'

export class Migration20260329220000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "pos_invoice_item" ADD COLUMN IF NOT EXISTS "refunded_quantity" integer NOT NULL DEFAULT 0;`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "pos_invoice_item" DROP COLUMN IF EXISTS "refunded_quantity";`)
    }
}
