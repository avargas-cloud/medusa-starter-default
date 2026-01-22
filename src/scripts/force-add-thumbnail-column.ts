import { config } from "dotenv"
import { Client } from "pg"

config()

async function forceAddColumn() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    })

    try {
        await client.connect()
        console.log("✅ Connected to database")

        // Check if column exists first to avoid errors
        const check = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'product_category' AND column_name = 'thumbnail';
        `)

        if (check.rows.length > 0) {
            console.log("ℹ️ Column 'thumbnail' already exists.")
        } else {
            console.log("⚠️ Column 'thumbnail' missing. Adding it manually...")
            await client.query(`
                ALTER TABLE product_category 
                ADD COLUMN thumbnail text;
            `)
            console.log("✅ Column 'thumbnail' added successfully!")
        }

    } catch (error) {
        console.error("❌ Error adding column:", error)
    } finally {
        await client.end()
        console.log("🔌 Disconnected")
    }
}

forceAddColumn()
