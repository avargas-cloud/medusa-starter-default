import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * AddCaseInsensitiveCustomerEmailIndex
 *
 * Adds a functional unique index on LOWER(customer.email) excluding soft-deleted rows.
 * This prevents duplicate customer records that differ only in email case (e.g. zombie
 * accounts created during deployments when browsers submit lowercase emails against
 * uppercase-stored records).
 *
 * IMPORTANT: Run merge-duplicate-customers.ts --execute BEFORE this migration,
 * otherwise the index creation will fail on existing violations.
 */
export class AddCaseInsensitiveCustomerEmailIndex1774920000000 implements MigrationInterface {
    name = 'AddCaseInsensitiveCustomerEmailIndex1774920000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS customer_email_lower_unique
            ON customer (LOWER(email))
            WHERE deleted_at IS NULL
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DROP INDEX IF EXISTS customer_email_lower_unique
        `)
    }
}
