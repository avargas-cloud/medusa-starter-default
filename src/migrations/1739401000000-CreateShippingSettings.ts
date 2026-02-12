import { MigrationInterface, QueryRunner } from "typeorm"

export class CreateShippingSettings1739401000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create shipping_settings table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS shipping_settings (
                id VARCHAR(255) PRIMARY KEY DEFAULT 'default',
                free_shipping_minimum INT NOT NULL DEFAULT 0,
                regular_ground_shipping_price INT NOT NULL DEFAULT 0,
                long_item_ground_shipping_price INT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `)

        // Insert default configuration
        await queryRunner.query(`
            INSERT INTO shipping_settings (
                id,
                free_shipping_minimum,
                regular_ground_shipping_price,
                long_item_ground_shipping_price,
                created_at,
                updated_at
            ) VALUES (
                'default',
                0,
                0,
                0,
                NOW(),
                NOW()
            )
            ON CONFLICT (id) DO NOTHING;
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS shipping_settings CASCADE;`)
    }
}
