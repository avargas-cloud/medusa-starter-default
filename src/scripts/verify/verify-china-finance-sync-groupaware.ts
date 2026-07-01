/**
 * Smoke test: syncVeetchBills group-aware path (changed-groups query + engine).
 * Verifies a vendor_bill line-total change routes through applyBillTotalChange
 * instead of blindly resetting a split root. BEGIN…ROLLBACK, sandbox only.
 * Run: env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *        npx ts-node src/scripts/verify/verify-china-finance-sync-groupaware.ts
 */
import { Client } from "pg";
import { applyBillTotalChange, type PgConn } from "../../lib/china-finance/bill-delta-engine";

const VEETECH = "qbvnd_01KPGGSG2J1BEEWQE5ET30AHFC";
const CHANGED_SQL = `
  WITH line_totals AS (
    SELECT vb.id AS vendor_bill_id,
           COALESCE((SELECT SUM(vbl.unit_cost_cents::bigint * vbl.qty)::integer
                     FROM vendor_bill_line vbl
                     WHERE vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL), 0) AS new_amount
    FROM vendor_bill vb
    WHERE vb.vendor_id = $1 AND vb.bill_type IN ('regular','service','freight') AND vb.deleted_at IS NULL
  )
  SELECT cfb.id AS root_id, lt.new_amount,
         COALESCE((SELECT SUM(g.amount_cents) FROM china_finance_bill g WHERE g.split_group_id = cfb.id),
                  cfb.amount_cents) AS group_total
  FROM china_finance_bill cfb
  JOIN line_totals lt ON lt.vendor_bill_id = cfb.vendor_bill_id
  WHERE cfb.type = 'vendor_bill' AND cfb.vendor_bill_id IS NOT NULL AND cfb.id LIKE 'de_%'`;

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`)); };
function adapt(c: Client): PgConn {
  return { raw: async (sql, b = []) => { let i = 0; const s = sql.replace(/\?/g, () => `$${++i}`); const r = await c.query(s, b as unknown[]); return { rows: r.rows as unknown[] }; } };
}

async function scenario(client: Client, name: string, lineTotal: number, expectChildAmount: number): Promise<void> {
  console.log(`\n▸ ${name} (vendor line ${lineTotal})`);
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO vendor_bill (id, vendor_id, bill_type, reference_id, document_date, created_at, updated_at) VALUES ('de_vb',$1,'regular','V-DE','2026-05-01', now(), now())`, [VEETECH]);
    await client.query(`INSERT INTO vendor_bill_line (id, vendor_bill_id, sku, description, unit_cost_cents, qty) VALUES ('de_vbl','de_vb','DE-SKU','test line',$1,1)`, [lineTotal]);
    await client.query(`INSERT INTO china_finance_bill (id,type,sort_order,vendor_bill_id,document_type,invoice_number,payee,amount_cents,document_date,due_date,split_group_id,partial_seq) VALUES ('de_r','vendor_bill',900,'de_vb','commercial_invoice','V-DE','T',2000,'2026-05-01','2026-05-20','de_r',1)`);
    await client.query(`INSERT INTO china_finance_bill (id,type,sort_order,document_type,invoice_number,payee,amount_cents,document_date,due_date,split_group_id,partial_seq) VALUES ('de_c','vendor_bill',900,'commercial_invoice','V-DE','T',1000,'2026-05-01','2026-05-20','de_r',2)`);
    await client.query(`INSERT INTO china_wire_transfer (id,status,sent_date,wire_amount_cents,received_amount_cents,confirmed_date) VALUES ('de_w1','confirmed','2026-05-01',2000,2000,'2026-05-02'),('de_w2','draft',NULL,1000,NULL,NULL)`);
    await client.query(`INSERT INTO china_wire_transfer_application (id,wire_transfer_id,bill_id,applied_cents,sort_order) VALUES ('de_a1','de_w1','de_r',2000,1),('de_a2','de_w2','de_c',1000,2)`);

    const changed = (await client.query(CHANGED_SQL, [VEETECH])).rows as Array<{ root_id: string; new_amount: number; group_total: number }>;
    check("query flags the group as changed", changed.length === 1 && changed[0]!.root_id === "de_r" && Number(changed[0]!.new_amount) === lineTotal && Number(changed[0]!.group_total) === 3000);
    for (const g of changed) {
      if (Number(g.new_amount) === Number(g.group_total)) continue;
      await applyBillTotalChange(adapt(client), { billId: g.root_id, targetTotalCents: Number(g.new_amount), source: "vendor_sync" });
    }
    const child = (await client.query(`SELECT amount_cents, applied_cents FROM china_finance_bill b LEFT JOIN china_wire_transfer_application a ON a.bill_id=b.id WHERE b.id='de_c'`)).rows[0] as { amount_cents: number; applied_cents: number } | undefined;
    const groupTotal = Number((await client.query(`SELECT SUM(amount_cents) t FROM china_finance_bill WHERE split_group_id='de_r'`)).rows[0]!.t);
    check(`child (last draft) → ${expectChildAmount}`, !!child && child.amount_cents === expectChildAmount && child.applied_cents === expectChildAmount);
    check("root confirmed untouched (2000)", (await client.query(`SELECT amount_cents FROM china_finance_bill WHERE id='de_r'`)).rows[0]!.amount_cents === 2000);
    check(`group total == vendor line (${lineTotal})`, groupTotal === lineTotal);
  } catch (e) { console.log(`  ⚠ threw: ${e instanceof Error ? e.message : e}`); fail++; }
  finally { await client.query("ROLLBACK"); }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await scenario(client, "increase absorbed by last draft", 3500, 1500);
  await scenario(client, "decrease absorbed by last draft", 2200, 200);
  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await client.end();
  process.exitCode = fail === 0 ? 0 : 1;
}
void main();
