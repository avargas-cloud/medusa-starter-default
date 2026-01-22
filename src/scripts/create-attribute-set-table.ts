import { ExecArgs } from "@medusajs/framework/types"
import { Client } from "pg"

export default async function (_: ExecArgs) {
    console.log("🔧 Manually creating attribute_set schema...\n")

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
    })

    try {
        await client.connect()
        console.log("✅ Connected to database\n")

        // Check if table exists
        console.log("1. Checking if attribute_set table exists...")
        const tableCheck = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'attribute_set'
            );
        `)

        if (tableCheck.rows[0].exists) {
            console.log("   ✅ Table 'attribute_set' already exists!\n")
        } else {
            console.log("   📝 Creating table...")

            await client.query(`
                CREATE TABLE public.attribute_set (
                    id text PRIMARY KEY,
                    handle text UNIQUE NOT NULL,
                    title text NOT NULL,
                    metadata jsonb,
                    created_at timestamp with time zone DEFAULT now() NOT NULL,
                    updated_at timestamp with time zone DEFAULT now() NOT NULL,
                    deleted_at timestamp with time zone
                );
            `)

            console.log("   ✅ Table created!\n")
        }

        // Check and add foreign key column
        console.log("2. Checking attribute_key.attribute_set_id column...")
        const columnCheck = await client.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'attribute_key' 
            AND column_name = 'attribute_set_id';
        `)

        if (columnCheck.rows.length === 0) {
            console.log("   📝 Adding column...")

            await client.query(`
                ALTER TABLE public.attribute_key 
                ADD COLUMN attribute_set_id text REFERENCES public.attribute_set(id) ON DELETE SET NULL;
            `)

            console.log("   ✅ Column added!\n")
        } else {
            console.log("   ✅ Column already exists!\n")
        }

        console.log("🎉 Database schema is ready!\n")

        // Show current structure
        const tables = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE 'attribute%'
            ORDER BY table_name;
        `)

        console.log("📋 Attribute-related tables:")
        tables.rows.forEach((row: any) => {
            console.log(`   - ${row.table_name}`)
        })

    } catch (error) {
        console.error("\n❌ Error:", (error as Error).message)
    } finally {
        await client.end()
    }
}
