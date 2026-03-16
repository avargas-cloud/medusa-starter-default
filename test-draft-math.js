const { Pool } = require("pg");
const pool = new Pool({ connectionString: "postgresql://postgres:postgres@localhost:5432/medusa-ecopowertech" });

async function run() {
  const oId = "order_01KKVTMDBQVKYGM9RVFS7J0ZA8";

  // Check what exact tax rate is applied to the draft line items
  const { rows } = await pool.query(`
    select otl.rate, otl.code, oi.unit_price, oi.quantity, osum.totals
    from order_tax_line otl
    join order_line_item oli on otl.item_id = oli.id
    join order_item oi on oli.id = oi.item_id
    join order_summary osum on osum.order_id = oi.order_id
    where oi.order_id = $1
      and otl.deleted_at is null
      and oli.deleted_at is null
      and oi.deleted_at is null
  `, [oId]);

  console.log("Tax Lines & Math:", JSON.stringify(rows, null, 2));

  pool.end();
}
run().catch(console.error);
