#!/usr/bin/env tsx
import { Client } from "pg";
async function check() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'product_category' ORDER BY ordinal_position"
  );
  console.table(r.rows);
  await c.end();
}
check();
