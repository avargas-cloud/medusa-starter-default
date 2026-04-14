import { Client } from "pg";

export default async function myScript() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const res = await client.query(
    `SELECT id, name, field_config FROM pos_document_template`
  );
  console.log(
    res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      print_flags_for_deposit: r.field_config?.summary_rows?.find(
        (sr: any) => sr.key === "deposit"
      ),
    }))
  );
  await client.end();
}
