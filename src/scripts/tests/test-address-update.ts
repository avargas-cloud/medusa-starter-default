import { getDbPool } from "../../../utils/db-pool";

async function runTest() {
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.ADMIN_CORS}`,
  };

  // Use the id S10060 if we know the Medusa ID. Actually, let's just query the DB.
  const pool = getDbPool();
  const res = await pool.query(
    `SELECT id, display_id FROM "order" WHERE display_id = 10060 AND deleted_at IS NULL`
  );
  const orderId = res.rows[0]?.id;

  if (!orderId) {
    console.log("Order S10060 not found");
    process.exit(1);
  }

  console.log("Found Order:", orderId);

  const payload = {
    shipping_address: {
      first_name: "Test",
      last_name: "Update",
      address_1: "999 Testing Ave",
      city: "Testville",
      country_code: "us",
    },
  };

  console.log("Sending payload:", payload);

  const base = `http://localhost:${process.env.PORT ?? 9000}`;
  const apiRes = await fetch(`${base}/admin/orders/${orderId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.POS_API_TOKEN || ""}`, // wait we just need a valid token. If from terminal, we might not have it.
    },
    body: JSON.stringify(payload),
  });

  if (!apiRes.ok) {
    console.log("API returned", apiRes.status, await apiRes.text());
    process.exit(1);
  }

  const data = await apiRes.json();
  console.log(
    "Success! Updated shipping address:",
    data.order.shipping_address
  );
}

runTest()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
