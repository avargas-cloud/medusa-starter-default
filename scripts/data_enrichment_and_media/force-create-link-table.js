
require('dotenv').config()
const { Client } = require('pg')

async function forceCreateTable() {
    console.log("🔥 Force Creating Link Table (Manual Override)...")

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })

    await client.connect()

    try {
        const tableName = "product_product_productattributes_attribute_value"

        console.log(`Creating table '${tableName}'...`)

        // standard link table schema for Medusa (with ID)
        await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE;`)
        await client.query(`
            CREATE TABLE "${tableName}" (
                "id" text NOT NULL,
                "product_id" text NOT NULL,
                "attribute_value_id" text NOT NULL,
                "created_at" timestamptz DEFAULT now() NOT NULL,
                "updated_at" timestamptz DEFAULT now() NOT NULL,
                "deleted_at" timestamptz,
                CONSTRAINT "${tableName}_pkey" PRIMARY KEY ("id"),
                CONSTRAINT "${tableName}_unique_pair" UNIQUE ("product_id", "attribute_value_id")
            );
        `)
        // Add Unique Constraint for the pair - DONE via CONSTRAINT above
        // await client.query(`CREATE UNIQUE INDEX "${tableName}_unique_pair" ON "${tableName}" ("product_id", "attribute_value_id") WHERE deleted_at IS NULL;`)

        // Add indices for performance (Medusa does this)
        await client.query(`CREATE INDEX IF NOT EXISTS "IDX_product_id_${tableName}" ON "${tableName}" ("product_id");`)
        await client.query(`CREATE INDEX IF NOT EXISTS "IDX_attribute_value_id_${tableName}" ON "${tableName}" ("attribute_value_id");`)

        console.log("✅ Table CREATED manually with Composite PK (1:N support).")

    } catch (e) {
        console.error("SQL Error:", e)
    } finally {
        await client.end()
    }
}

forceCreateTable()
