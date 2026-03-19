import { Client } from "pg";
import * as fs from "fs";

async function run() {
    const env = fs.readFileSync('.env', 'utf8');
    const dbUrl = env.split('\n').find(l => l.startsWith('DATABASE_URL')).split('=')[1].replace(/['"\r]/g, '');
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    console.log("Connected to DB");
    try {
        const res = await client.query("SELECT id, order_id, name, amount, version, created_at, deleted_at FROM order_shipping_method WHERE order_id = 'order_01KM3J0VSBB27H8X4RNK0N0KZZ' ORDER BY created_at DESC");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        await client.end();
        process.exit(0);
    }
}
run();
