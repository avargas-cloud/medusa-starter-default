import { Client } from "pg";
import { loadDailyReport } from "/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/accounting/treasury/_lib/load-daily-report";

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const pg = {
    raw: async (sql: string, params: unknown[] = []) => {
      let i = 0;
      return client.query(sql.replace(/\?/g, () => `$${++i}`), params as any[]);
    },
  };
  const r = await loadDailyReport(pg as any, "2026-07-18", "2026-07-18");
  for (const s of r.splits) console.log(s.code, (s.amount_cents / 100).toFixed(2));
  const sum = r.splits.reduce((a, s) => a + s.amount_cents, 0);
  console.log(
    "sum_splits(recalc):",
    (sum / 100).toFixed(2),
    "net_cash:",
    (r.totals.net_cash_received_cents / 100).toFixed(2),
    "reconciliation.delta:",
    r.reconciliation.delta_cents
  );
  await client.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
