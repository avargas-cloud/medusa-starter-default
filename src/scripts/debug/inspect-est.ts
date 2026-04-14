import { Client } from "pg";

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
  await client.connect();
  const res = await client.query(
    `SELECT id, display_id, is_draft_order, created_at, canceled_at FROM "order" WHERE display_id IN (1255, 1256)`
  );
  console.log(JSON.stringify(res.rows, null, 2));

  const cronRes = await client.query(`
        SELECT id, display_id
        FROM "order"
        WHERE canceled_at IS NULL
          AND is_draft_order = true
          AND created_at <= NOW() - INTERVAL '1 hour'
          AND created_at >= NOW() - INTERVAL '24 hours'
          AND (
              sales_channel_id = 'sc_15154EAF0D194265ADD21AAD2D'
              OR metadata->>'pos_created' = 'true'
          )
    `);
  console.log("CRON MATCHES: ", cronRes.rows);
  await client.end();
}

run().catch(console.error);
