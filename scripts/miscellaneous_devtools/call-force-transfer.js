const { sign } = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const env = fs.readFileSync(path.resolve(__dirname, "../.env"), "utf8");
const secretMatch = env.match(/JWT_SECRET=(.+)/);
const secret = secretMatch ? secretMatch[1] : null;

const token = sign({ actor_id: "user_01KKP78MHFK2FNR63BEMH32V8Y", actor_type: "user" }, secret, { expiresIn: "10h" });

// get a customer id 
const pg = require("pg");
const pool = new pg.Pool({ connectionString: env.match(/DATABASE_URL=(.+)/)[1] });

async function run() {
  const { rows } = await pool.query("SELECT id FROM customer LIMIT 1 OFFSET 1"); // just to pick a different customer
  const customerId = rows[0].id;
  console.log("Using customer:", customerId);

  // use the force-transfer API we created
  const r = await fetch("http://localhost:9000/admin/orders/order_01KKP94867YW6167D4J4T38441/transfer-force", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: customerId })
  });
  const text = await r.text();
  console.log("Response:", r.status, text);

  // check db
  const { rows: orderRows } = await pool.query("SELECT customer_id FROM \"order\" WHERE id = 'order_01KKP94867YW6167D4J4T38441'");
  console.log("Customer on order in DB:", orderRows[0].customer_id);
  
  pool.end();
}
run();
