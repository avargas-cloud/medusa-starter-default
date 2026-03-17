const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query("UPDATE tax_region SET provider_id = 'system' WHERE provider_id IS NULL", (err, res) => {
    if (err) console.error(err); else console.log("Updated", res.rowCount, "regions");
    pool.end();
});
