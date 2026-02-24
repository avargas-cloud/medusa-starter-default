import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();
async function run() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    await client.connect();
    const res = await client.query("select display_id, items, summary from \"order\" where status = 'pending' order by display_id desc limit 3");
    console.log(JSON.stringify(res.rows, null, 2));
    await client.end();
}
run();
