import { Migration } from "@mikro-orm/migrations"

export class Migration20260329230000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "qb_bank_account" ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false;`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "qb_bank_account" DROP COLUMN IF EXISTS "is_default";`)
    }
}
