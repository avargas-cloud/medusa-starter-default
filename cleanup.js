const { Client } = require('pg');

async function run() {
    // Connect explicitly via host network to PG container if typical environment URL hangs
    // In many local dev environments with Docker, the port might be mapped differently or require specific host.
    // Try the standard connection string first.
    const client = new Client({ connectionString: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/ecopowertech" });
    
    try {
        await client.connect();
        console.log("Connected to DB");
        const res = await client.query(`
            WITH duplicates AS (
                SELECT id,
                    ROW_NUMBER() OVER(PARTITION BY context, field_name, value ORDER BY updated_at DESC) as rn
                FROM system_defaults
            )
            DELETE FROM system_defaults
            WHERE id IN (SELECT id FROM duplicates WHERE rn > 1);
        `);
        console.log("Deleted duplicate rows:", res.rowCount);
    } catch (e) {
        console.error("DB Error:", e.message);
    } finally {
        await client.end();
    }
}

run();
