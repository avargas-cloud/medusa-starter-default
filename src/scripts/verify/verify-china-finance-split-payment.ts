/**
 * Verify splitBillForPartialPayment (Rule 6). BEGIN…ROLLBACK, sandbox only.
 * Run: env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *        npx ts-node src/scripts/verify/verify-china-finance-split-payment.ts
 */
import { Client } from "pg";
import { splitBillForPartialPayment, mergePartialToAmount } from "../../lib/china-finance/bill-split-payment";
import type { PgConn } from "../../lib/china-finance/bill-delta-engine";

function adapt(c: Client): PgConn {
  return { raw: async (sql, b = []) => { let i = 0; const s = sql.replace(/\?/g, () => `$${++i}`); const r = await c.query(s, b as unknown[]); return { rows: r.rows as unknown[] }; } };
}
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`)); };

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("Split-payment (rule 6) verify");
  await client.query("BEGIN");
  try {
    await client.query(`INSERT INTO china_finance_bill (id,type,sort_order,document_type,invoice_number,payee,amount_cents,document_date,due_date) VALUES ('sp_b','legacy',1,'commercial_invoice','SP-1','T',324658,'2026-05-01','2026-05-20')`);
    await client.query(`INSERT INTO china_wire_transfer (id,status,sent_date,wire_amount_cents) VALUES ('sp_w','draft',NULL,324658)`);
    await client.query(`INSERT INTO china_wire_transfer_application (id,wire_transfer_id,bill_id,applied_cents,sort_order) VALUES ('sp_a','sp_w','sp_b',324658,1)`);

    const res = await splitBillForPartialPayment(adapt(client), { billId: "sp_b", payNowCents: 304658 });
    const rows = (await client.query(`SELECT b.id, b.partial_seq, b.amount_cents, b.split_group_id, a.applied_cents AS applied, w.status AS wire_status
      FROM china_finance_bill b LEFT JOIN china_wire_transfer_application a ON a.bill_id=b.id LEFT JOIN china_wire_transfer w ON w.id=a.wire_transfer_id
      WHERE b.split_group_id='sp_b' ORDER BY b.partial_seq`)).rows as Array<{ partial_seq: number; amount_cents: number; applied: number | null; wire_status: string | null }>;

    check("2 partials in group", rows.length === 2);
    const p1 = rows.find((r) => r.partial_seq === 1)!; const p2 = rows.find((r) => r.partial_seq === 2)!;
    check("Partial #1 = paid 3046.58 on draft (amount==applied)", p1.amount_cents === 304658 && p1.applied === 304658 && p1.wire_status === "draft");
    check("Partial #2 = remainder 200.00 unassigned", p2.amount_cents === 20000 && p2.applied === null && p2.wire_status === null);
    check("total preserved (324658)", p1.amount_cents + p2.amount_cents === 324658);
    check("result remainder = 20000", res.remainderCents === 20000);

    // Merge (rule 7): raise Partial #1 back to full → Partial #2 deleted, collapse.
    const mres = await mergePartialToAmount(adapt(client), { billId: "sp_b", newAmountCents: 324658 });
    const after = (await client.query(`SELECT b.id, b.amount_cents, COALESCE(b.split_group_id,'unsplit') sg, a.applied_cents AS applied
      FROM china_finance_bill b LEFT JOIN china_wire_transfer_application a ON a.bill_id=b.id
      WHERE b.id='sp_b' OR b.split_group_id='sp_b'`)).rows as Array<{ id: string; amount_cents: number; sg: string; applied: number | null }>;
    check("merge: 1 row left (Partial #2 deleted)", after.length === 1);
    check("merge: unsplit, amount 324658, applied 324658", after[0]!.amount_cents === 324658 && after[0]!.sg === "unsplit" && after[0]!.applied === 324658);
    check("merge: collapsedToUnsplit + 1 deleted", mres.collapsedToUnsplit === true && mres.deletedPartialIds.length === 1);

    // Guard: cannot split an unassigned bill.
    await client.query(`INSERT INTO china_finance_bill (id,type,sort_order,document_type,invoice_number,payee,amount_cents,document_date,due_date) VALUES ('sp_u','legacy',2,'commercial_invoice','SP-U','T',5000,'2026-05-01','2026-05-20')`);
    let threw = false;
    try { await splitBillForPartialPayment(adapt(client), { billId: "sp_u", payNowCents: 2000 }); } catch { threw = true; }
    check("guard: unassigned bill rejects", threw);

    // Root-protection: root unassigned ($40) + non-root child ($60) on draft;
    // raising the CHILD must NOT delete the root (identity) → throws.
    await client.query(`INSERT INTO china_finance_bill (id,type,sort_order,vendor_bill_id,document_type,invoice_number,payee,amount_cents,document_date,due_date,split_group_id,partial_seq) VALUES ('rp_root','vendor_bill',3,NULL,'commercial_invoice','RP','T',4000,'2026-05-01','2026-05-20','rp_root',1)`);
    await client.query(`INSERT INTO china_finance_bill (id,type,sort_order,document_type,invoice_number,payee,amount_cents,document_date,due_date,split_group_id,partial_seq) VALUES ('rp_child','vendor_bill',3,'commercial_invoice','RP','T',6000,'2026-05-01','2026-05-20','rp_root',2)`);
    await client.query(`INSERT INTO china_wire_transfer (id,status,wire_amount_cents) VALUES ('rp_w','draft',6000)`);
    await client.query(`INSERT INTO china_wire_transfer_application (id,wire_transfer_id,bill_id,applied_cents,sort_order) VALUES ('rp_a','rp_w','rp_child',6000,1)`);
    let rpThrew = false;
    try { await mergePartialToAmount(adapt(client), { billId: "rp_child", newAmountCents: 10000 }); } catch { rpThrew = true; }
    const rootAlive = (await client.query(`SELECT vendor_bill_id FROM china_finance_bill WHERE id='rp_root'`)).rows.length === 1;
    check("root-protection: raising non-root over root's amount rejects", rpThrew);
    check("root-protection: root row still alive (identity kept)", rootAlive);
  } catch (e) { console.log(`  ⚠ threw: ${e instanceof Error ? e.message : e}`); fail++; }
  finally { await client.query("ROLLBACK"); }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await client.end();
  process.exitCode = fail === 0 ? 0 : 1;
}
void main();
