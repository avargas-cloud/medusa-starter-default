import { Client } from "pg";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query("BEGIN");
  try {
    const { rows } = await client.query(`
            SELECT of.fulfillment_id FROM order_fulfillment of
            LEFT JOIN "order" o ON of.order_id = o.id
            WHERE o.id IS NULL
        `);

    const fIds = rows.map((r) => r.fulfillment_id);
    if (fIds.length > 0) {
      await client.query(
        `DELETE FROM order_fulfillment WHERE fulfillment_id = ANY($1::text[])`,
        [fIds]
      );
      await client.query(`DELETE FROM fulfillment WHERE id = ANY($1::text[])`, [
        fIds,
      ]);
      console.log(`Deleted ${fIds.length} orphaned fulfillments.`);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
  }
  await client.end();
}
main();
