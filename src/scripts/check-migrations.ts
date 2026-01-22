import { config } from "dotenv"
import { Client } from "pg"

config()

async function debugSchema() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    })

    try {
        await client.connect()
        console.log("✅ Connected to database")

        // Check columns in product_category
        const columns = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'product_category';
        `)

        console.log("\n📊 Columns in product_category:")
        console.table(columns.rows)

        // Check migrations table
        try {
            const migrations = await client.query(`
                SELECT * FROM "typeorm_metadata" WHERE type = 'MIGRATION';
            `) // Medusa v1 uses typeorm_metadata, checking if v2 is same or distinct table
            // Actually Medusa usually uses `migration` table or similar. Let's try listing all tables first if that fails

            // Let's try standard TypeORM migration table if it exists
            const migrationsTable = await client.query(`
                SELECT * FROM migrations
             `)
            console.log("\n📜 Executed Migrations:")
            console.table(migrationsTable.rows)
        } catch (e) {
            console.log("Could not query 'migrations' table directly:", e.message)

            // List all tables to find migration table
            const tables = await client.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public';
            `)
            console.log("\n🗃️ Tables in DB:", tables.rows.map(r => r.table_name).join(", "))
        }

    } catch (error) {
        console.error("Error:", error)
    } finally {
        await client.end()
    }
}

debugSchema()
