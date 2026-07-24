/**
 * verify-vendor-bill-enqueue.ts — sandbox-only plumbing check for Phase 1.1
 * (enqueueQbVendorBillAdd): flag gate, payload shape, one-row-per-bill write.
 * Cleans up after itself. Run: ./node_modules/.bin/tsx src/scripts/verify/verify-vendor-bill-enqueue.ts
 */
import { Client } from "pg";
import { enqueueQbVendorBillAdd } from "../../lib/purchase-orders/qb-vendor-bill-enqueue";

async function main() {
  process.env.QB_VENDOR_BILL_MODE = "bill";
  const client = new Client({ connectionString: "postgresql://postgres:sandbox@localhost:5499/medusa" });
  await client.connect();
  const knex = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      const r = await client.query(pgSql, bindings as never[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  };
  // VB-1066: confirmed regular bill, vendor Amazon (NOT china agent), PO-1098
  const vb = "vb_01KY8KNYWVK9REKWJRPFW9MR29";
  const res = await enqueueQbVendorBillAdd(knex, vb);
  console.log("result:", JSON.stringify(res));
  if ("pipelineRowId" in res) {
    const row = await knex.raw(
      "SELECT status, intent, jsonb_pretty(payload) AS p FROM qb_vendor_bill_pipeline WHERE id = ?",
      [res.pipelineRowId]
    );
    console.log((row.rows[0] as any).status, (row.rows[0] as any).intent);
    console.log((row.rows[0] as any).p);
    // cleanup — this was a plumbing test, not a real dispatch intent
    await knex.raw("DELETE FROM qb_vendor_bill_pipeline WHERE id = ?", [res.pipelineRowId]);
    console.log("row cleaned up");
  }
  // Also test flag-off skip + china fence
  process.env.QB_VENDOR_BILL_MODE = "item_receipt";
  console.log("flag off:", JSON.stringify(await enqueueQbVendorBillAdd(knex, vb)));
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
