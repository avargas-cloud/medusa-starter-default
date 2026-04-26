import { getDbPool } from "./src/utils/db-pool";

async function run() {
  require("dotenv").config();
  const pool = getDbPool();
  try {
    const res = await pool.query(
      "SELECT id, order_id, name, amount, version, created_at, deleted_at FROM order_shipping_method WHERE order_id = 'order_01KM3J0VSBB27H8X4RNK0N0KZZ' ORDER BY created_at DESC"
    );
    console.log(JSON.stringify(res.rows, null, 2));
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
run();
