import { Client } from "pg";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const res = await client.query(`
        SELECT p.id, p.title, pv.sku, pv.title AS vtitle
        FROM product p
        JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
        WHERE p.deleted_at IS NULL
          AND (p.title ILIKE 'EPS-SPR-S-W%' OR p.title ILIKE 'EPS-SPR-SPLBO%')
        ORDER BY p.title, pv.id
    `);
  for (const r of res.rows)
    console.log(r.id, "|", r.title, "|", r.sku, "|", r.vtitle);
  await client.end();
}
main().catch(console.error);
