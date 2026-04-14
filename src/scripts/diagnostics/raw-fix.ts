import { Pool } from "pg";
import { config } from "dotenv";
config();

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Find the exact items for order 1239. It was created recently.
  const res = await pool.query(
    `SELECT id, title, fulfilled_quantity, created_at 
     FROM order_item 
     WHERE (title LIKE '%Aluminum Channel Silver%' OR title LIKE '%UL FREECUT COB LED Strip%')
     ORDER BY created_at DESC 
     LIMIT 5`
  );

  console.log("Recent items found:");
  for (const row of res.rows) {
    console.log(
      `- ${row.id} | ${row.title} | ${row.created_at} | fulfilled: ${row.fulfilled_quantity}`
    );

    // Only update items from today that have fulfilled_quantity > 0
    if (row.fulfilled_quantity > 0) {
      console.log(`  -> Resetting ${row.id}...`);
      await pool.query(
        `UPDATE order_item SET fulfilled_quantity = 0, delivered_quantity = 0 WHERE id = $1`,
        [row.id]
      );
      console.log(`  -> Reset done!`);
    }
  }

  console.log("Finished.");
  process.exit(0);
}

run().catch(console.error);
