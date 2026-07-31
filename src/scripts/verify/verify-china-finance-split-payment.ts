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

    // ── Bills that ALREADY carry confirmed money ──────────────────────────────
    // Everything above runs with zero confirmed payments, which is why the whole
    // block passed while production inverted VB-1053. `amount_cents` and the open
    // balance are the same number until a wire confirms; only then do the two
    // readings diverge, and only then does judging against the wrong one show.

    // (A) The regression, to the cent: a bill paid IN FULL and then corrected
    // upward. The correction is all that's open, so paying it defers nothing and
    // there is nothing to split. The old code split here — shrinking the row that
    // held the confirmed payment and re-billing money already wired.
    await client.query(`INSERT INTO china_finance_bill (id,type,sort_order,document_type,invoice_number,payee,amount_cents,document_date,due_date) VALUES ('pa_b','vendor_bill',4,'commercial_invoice','PA-1','T',377515,'2026-07-06','2026-07-27')`);
    await client.query(`INSERT INTO china_wire_transfer (id,status,sent_date,confirmed_date,wire_amount_cents) VALUES ('pa_wc','confirmed','2026-07-27','2026-07-27',376337)`);
    await client.query(`INSERT INTO china_wire_transfer_application (id,wire_transfer_id,bill_id,applied_cents,sort_order) VALUES ('pa_ac','pa_wc','pa_b',376337,0)`);
    await client.query(`INSERT INTO china_wire_transfer (id,status,wire_amount_cents) VALUES ('pa_wd','draft',1178)`);
    await client.query(`INSERT INTO china_wire_transfer_application (id,wire_transfer_id,bill_id,applied_cents,sort_order) VALUES ('pa_ad','pa_wd','pa_b',1178,0)`);
    let paThrew = false;
    try { await splitBillForPartialPayment(adapt(client), { billId: "pa_b", payNowCents: 1178 }); } catch { paThrew = true; }
    const paRows = (await client.query(`SELECT id, amount_cents, split_group_id, partial_seq FROM china_finance_bill WHERE id='pa_b' OR split_group_id='pa_b'`)).rows as Array<{ amount_cents: number; split_group_id: string | null; partial_seq: number | null }>;
    const paApps = (await client.query(`SELECT id, applied_cents FROM china_wire_transfer_application WHERE bill_id='pa_b' ORDER BY id`)).rows as Array<{ id: string; applied_cents: number }>;
    check("paid-then-raised: paying the whole open balance REJECTS the split", paThrew);
    check("paid-then-raised: still ONE row, un-split, amount untouched", paRows.length === 1 && paRows[0]!.amount_cents === 377515 && paRows[0]!.split_group_id === null && paRows[0]!.partial_seq === null);
    check("paid-then-raised: both applications untouched (376337 + 1178)", paApps.length === 2 && paApps.find((a) => a.id === "pa_ac")!.applied_cents === 376337 && paApps.find((a) => a.id === "pa_ad")!.applied_cents === 1178);

    // (B) CONTROL POSITIVE. Without this, (A) proves nothing — a split that
    // refused everything would pass it. A genuine partial ON TOP of confirmed
    // money must still split, and the root must keep enough amount to carry the
    // payment already sitting on it.
    await client.query(`INSERT INTO china_finance_bill (id,type,sort_order,document_type,invoice_number,payee,amount_cents,document_date,due_date) VALUES ('pb_b','vendor_bill',5,'commercial_invoice','PB-1','T',100000,'2026-07-06','2026-07-27')`);
    await client.query(`INSERT INTO china_wire_transfer (id,status,sent_date,confirmed_date,wire_amount_cents) VALUES ('pb_wc','confirmed','2026-07-10','2026-07-10',60000)`);
    await client.query(`INSERT INTO china_wire_transfer_application (id,wire_transfer_id,bill_id,applied_cents,sort_order) VALUES ('pb_ac','pb_wc','pb_b',60000,0)`);
    await client.query(`INSERT INTO china_wire_transfer (id,status,wire_amount_cents) VALUES ('pb_wd','draft',15000)`);
    await client.query(`INSERT INTO china_wire_transfer_application (id,wire_transfer_id,bill_id,applied_cents,sort_order) VALUES ('pb_ad','pb_wd','pb_b',15000,0)`);
    const pbRes = await splitBillForPartialPayment(adapt(client), { billId: "pb_b", payNowCents: 15000 });
    const pbRows = (await client.query(`SELECT id, amount_cents, partial_seq FROM china_finance_bill WHERE split_group_id='pb_b' ORDER BY partial_seq`)).rows as Array<{ id: string; amount_cents: number; partial_seq: number }>;
    const pbApps = (await client.query(`SELECT id, applied_cents FROM china_wire_transfer_application WHERE bill_id='pb_b' ORDER BY id`)).rows as Array<{ id: string; applied_cents: number }>;
    check("partial over confirmed: 2 partials", pbRows.length === 2);
    check("partial over confirmed: root = confirmed + paid now (75000), NOT 15000", pbRows[0]!.amount_cents === 75000);
    check("partial over confirmed: remainder = balance - paid (25000)", pbRows[1]!.amount_cents === 25000 && pbRes.remainderCents === 25000);
    check("partial over confirmed: group total preserved (100000)", pbRows[0]!.amount_cents + pbRows[1]!.amount_cents === 100000);
    check("partial over confirmed: confirmed app untouched, draft app = paid now", pbApps.find((a) => a.id === "pb_ac")!.applied_cents === 60000 && pbApps.find((a) => a.id === "pb_ad")!.applied_cents === 15000);

    // (C) The merge mirror. Raising that partial back to the full bill must set
    // its DRAFT application to what's still open (100000 − 60000), never to the
    // new amount — that would re-schedule the 60000 already wired and inflate the
    // draft wire by exactly that much.
    await mergePartialToAmount(adapt(client), { billId: "pb_b", newAmountCents: 100000 });
    const pbAfter = (await client.query(`SELECT b.amount_cents, COALESCE(b.split_group_id,'unsplit') sg FROM china_finance_bill b WHERE b.id='pb_b' OR b.split_group_id='pb_b'`)).rows as Array<{ amount_cents: number; sg: string }>;
    const pbDraftApp = (await client.query(`SELECT applied_cents FROM china_wire_transfer_application WHERE id='pb_ad'`)).rows[0] as { applied_cents: number };
    const pbConfApp = (await client.query(`SELECT applied_cents FROM china_wire_transfer_application WHERE id='pb_ac'`)).rows[0] as { applied_cents: number };
    check("merge over confirmed: collapsed back to one un-split row of 100000", pbAfter.length === 1 && pbAfter[0]!.amount_cents === 100000 && pbAfter[0]!.sg === "unsplit");
    check("merge over confirmed: draft app = 40000 (open), NOT 100000", pbDraftApp.applied_cents === 40000);
    check("merge over confirmed: confirmed app still 60000", pbConfApp.applied_cents === 60000);
  } catch (e) { console.log(`  ⚠ threw: ${e instanceof Error ? e.message : e}`); fail++; }
  finally { await client.query("ROLLBACK"); }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAIL"} — ${pass} passed, ${fail} failed`);
  await client.end();
  process.exitCode = fail === 0 ? 0 : 1;
}
void main();
