import { Client } from "pg";
import { loadCreditMemoMovements } from "../../api/admin/accounting/treasury/_lib/load-cm-movements";

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const pg = {
    raw: async (sql: string, params: unknown[] = []) => {
      let i = 0;
      return client.query(sql.replace(/\?/g, () => `$${++i}`), params as any[]);
    },
  };
  const day = process.argv[2] ?? "2026-07-18";
  const rows = await loadCreditMemoMovements(
    pg as any,
    `${day} 00:00:00`,
    `${day} 23:59:59.999999`
  );
  for (const r of rows) {
    console.log(
      r.reference,
      r.payment_application_id,
      "value:", r.amount_applied_cents,
      "current:", r.current_bucket,
      "resolution:", r.resolution,
      "target:", r.resolution_target_bucket,
      "res_amount:", r.resolution_amount_cents,
      "stale:", r.resolution_stale
    );
  }
  await client.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
