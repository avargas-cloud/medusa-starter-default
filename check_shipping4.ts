import { Client } from "pg";
import * as fs from "fs";

async function run() {
    const env = fs.readFileSync('.env', 'utf8');
    const dbUrl = env.split('\n').find(l => l.startsWith('DATABASE_URL')).split('=')[1].replace(/['"\r]/g, '');
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
        const res = await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'order%shipping%method%'");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch(e) {
        console.error(e);
    } finally {
        await client.end();
        process.exit(0);
    }
}
run();
