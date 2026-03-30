import { Migration } from '@mikro-orm/migrations'

export class Migration20260329215000 extends Migration {
    async up(): Promise<void> {
        // Add refunded_amount and refunded_shipping columns
        this.addSql(`ALTER TABLE "pos_invoice" ADD COLUMN IF NOT EXISTS "refunded_amount" numeric NOT NULL DEFAULT 0;`)
        this.addSql(`ALTER TABLE "pos_invoice" ADD COLUMN IF NOT EXISTS "raw_refunded_amount" jsonb NULL;`)
        this.addSql(`ALTER TABLE "pos_invoice" ADD COLUMN IF NOT EXISTS "refunded_shipping" numeric NOT NULL DEFAULT 0;`)
        this.addSql(`ALTER TABLE "pos_invoice" ADD COLUMN IF NOT EXISTS "raw_refunded_shipping" jsonb NULL;`)

        // Extend status check constraint to include refund states
        this.addSql(`ALTER TABLE "pos_invoice" DROP CONSTRAINT IF EXISTS "pos_invoice_status_check";`)
        this.addSql(`ALTER TABLE "pos_invoice" ADD CONSTRAINT "pos_invoice_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'issued'::text, 'partial'::text, 'paid'::text, 'voided'::text, 'partially_refunded'::text, 'refunded'::text]));`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "pos_invoice" DROP COLUMN IF EXISTS "refunded_amount";`)
        this.addSql(`ALTER TABLE "pos_invoice" DROP COLUMN IF EXISTS "raw_refunded_amount";`)
        this.addSql(`ALTER TABLE "pos_invoice" DROP COLUMN IF EXISTS "refunded_shipping";`)
        this.addSql(`ALTER TABLE "pos_invoice" DROP COLUMN IF EXISTS "raw_refunded_shipping";`)
        this.addSql(`ALTER TABLE "pos_invoice" DROP CONSTRAINT IF EXISTS "pos_invoice_status_check";`)
        this.addSql(`ALTER TABLE "pos_invoice" ADD CONSTRAINT "pos_invoice_status_check" CHECK (status = ANY (ARRAY['draft'::text, 'issued'::text, 'partial'::text, 'paid'::text, 'voided'::text]));`)
    }
}
