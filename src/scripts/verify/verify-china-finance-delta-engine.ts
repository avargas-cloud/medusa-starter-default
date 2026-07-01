/**
 * scripts/verify/verify-china-finance-delta-engine.ts
 *
 * Integration verification for applyBillTotalChange (F2 delta engine). Runs each
 * scenario inside its own BEGIN…ROLLBACK against the SANDBOX db, so nothing
 * persists. Exercises rules 1–7 of the split-bill case matrix + guards.
 *
 * Run: env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *        npx ts-node src/scripts/verify/verify-china-finance-delta-engine.ts
 */

import { Client } from "pg";
import { applyBillTotalChange, type PgConn } from "../../lib/china-finance/bill-delta-engine";

/** Adapt a pg Client to the engine's knex-style `?`-binding raw interface. */
function adapt(client: Client): PgConn {
  return {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      const r = await client.query(converted, bindings as unknown[]);
      return { rows: r.rows as unknown[] };
    },
  };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

type Row = { id: string; partial_seq: number | null; amount_cents: number; split_group_id: string | null;
  applied: number | null; wire_status: string | null };

async function state(client: Client, groupId: string): Promise<Row[]> {
  const r = await client.query(
    `SELECT b.id, b.partial_seq, b.amount_cents, b.split_group_id,
            a.applied_cents AS applied, w.status AS wire_status
       FROM china_finance_bill b
       LEFT JOIN china_wire_transfer_application a ON a.bill_id=b.id
       LEFT JOIN china_wire_transfer w ON w.id=a.wire_transfer_id
      WHERE b.split_group_id=$1 OR (b.id=$1 AND b.split_group_id IS NULL)
      ORDER BY b.partial_seq ASC NULLS FIRST`,
    [groupId]
  );
  return r.rows as Row[];
}
async function wireAmt(client: Client, id: string): Promise<number> {
  const r = await client.query(`SELECT wire_amount_cents FROM china_wire_transfer WHERE id=$1`, [id]);
  return (r.rows[0] as { wire_amount_cents: number } | undefined)?.wire_amount_cents ?? -1;
}

async function seedBill(c: Client, id: string, amount: number, type = "legacy"): Promise<void> {
  await c.query(
    `INSERT INTO china_finance_bill (id,type,sort_order,document_type,invoice_number,payee,amount_cents,document_date,due_date)
     VALUES ($1,$2,1,'commercial_invoice',$1,'T',$3,'2026-05-01','2026-05-20')`, [id, type, amount]);
}
async function seedWire(c: Client, id: string, status: string, amount: number): Promise<void> {
  await c.query(
    `INSERT INTO china_wire_transfer (id,status,sent_date,wire_amount_cents,received_amount_cents,confirmed_date)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, status, status === "confirmed" ? "2026-05-01" : null, amount, status === "confirmed" ? amount : null, status === "confirmed" ? "2026-05-02" : null]);
}
async function seedApp(c: Client, id: string, wireId: string, billId: string, applied: number, seq: number): Promise<void> {
  await c.query(`INSERT INTO china_wire_transfer_application (id,wire_transfer_id,bill_id,applied_cents,sort_order) VALUES ($1,$2,$3,$4,$5)`,
    [id, wireId, billId, applied, seq]);
}
async function markSplit(c: Client, id: string, groupId: string, seq: number): Promise<void> {
  await c.query(`UPDATE china_finance_bill SET split_group_id=$2, partial_seq=$3 WHERE id=$1`, [id, groupId, seq]);
}

async function scenario(client: Client, name: string, body: (db: PgConn) => Promise<void>): Promise<void> {
  console.log(`\n▸ ${name}`);
  await client.query("BEGIN");
  try {
    await client.query(`DELETE FROM china_wire_transfer_application WHERE id LIKE 'de_%'`);
    await client.query(`DELETE FROM china_finance_bill WHERE id LIKE 'de_%' OR split_group_id LIKE 'de_%'`);
    await client.query(`DELETE FROM china_wire_transfer WHERE id LIKE 'de_%'`);
    await body(adapt(client));
  } catch (e) {
    console.log(`  ⚠ scenario threw: ${e instanceof Error ? e.message : e}`);
  } finally {
    await client.query("ROLLBACK");
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`Delta engine verify — db=${(process.env.DATABASE_URL ?? "").replace(/:[^:@/]*@/, ":***@")}`);

  // R1 — unsplit draft increase → grow amount + app + wire, stays unsplit.
  await scenario(client, "R1 unsplit draft increase", async (db) => {
    await seedBill(client, "de_b", 1000); await seedWire(client, "de_w", "draft", 1000);
    await seedApp(client, "de_a", "de_w", "de_b", 1000, 1);
    await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 1500, source: "manual_edit" });
    const s = await state(client, "de_b");
    check("1 row, unsplit", s.length === 1 && s[0]!.split_group_id === null);
    check("amount 1500 / applied 1500", s[0]!.amount_cents === 1500 && s[0]!.applied === 1500);
    check("wire 1500", (await wireAmt(client, "de_w")) === 1500);
  });

  // R2 — split, last=draft increase → grow last child + its draft wire only.
  await scenario(client, "R2 split last-draft increase", async (db) => {
    await seedBill(client, "de_b", 2000); await markSplit(client, "de_b", "de_b", 1);
    await seedWire(client, "de_w1", "confirmed", 2000); await seedApp(client, "de_a1", "de_w1", "de_b", 2000, 1);
    await seedBill(client, "de_c", 1000); await markSplit(client, "de_c", "de_b", 2);
    await seedWire(client, "de_w2", "draft", 1000); await seedApp(client, "de_a2", "de_w2", "de_c", 1000, 2);
    await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 3500, source: "manual_edit" });
    const s = await state(client, "de_b");
    const root = s.find((r) => r.partial_seq === 1)!; const child = s.find((r) => r.partial_seq === 2)!;
    check("root unchanged 2000", root.amount_cents === 2000);
    check("child grown to 1500 / applied 1500", child.amount_cents === 1500 && child.applied === 1500);
    check("draft wire w2 → 1500", (await wireAmt(client, "de_w2")) === 1500);
    check("confirmed wire w1 untouched 2000", (await wireAmt(client, "de_w1")) === 2000);
  });

  // R3 — unsplit confirmed increase → promote + new unassigned Partial #2.
  await scenario(client, "R3 unsplit confirmed increase → #2", async (db) => {
    await seedBill(client, "de_b", 2000); await seedWire(client, "de_w", "confirmed", 2000);
    await seedApp(client, "de_a", "de_w", "de_b", 2000, 1);
    await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 3000, source: "manual_edit" });
    const s = await state(client, "de_b");
    check("2 rows now (split)", s.length === 2);
    const root = s.find((r) => r.partial_seq === 1)!; const child = s.find((r) => r.partial_seq === 2)!;
    check("root seq1 amount 2000 confirmed", root.amount_cents === 2000 && root.wire_status === "confirmed" && root.split_group_id === "de_b");
    check("child seq2 amount 1000 unassigned", child.amount_cents === 1000 && child.wire_status === null && child.applied === null);
  });

  // R5 — unsplit confirmed decrease → reduce amount only, applied stays (credit).
  await scenario(client, "R5 confirmed decrease → credit", async (db) => {
    await seedBill(client, "de_b", 2000); await seedWire(client, "de_w", "confirmed", 2000);
    await seedApp(client, "de_a", "de_w", "de_b", 2000, 1);
    const res = await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 1500, source: "manual_edit" });
    const s = await state(client, "de_b");
    check("still 1 row unsplit", s.length === 1 && s[0]!.split_group_id === null);
    check("amount 1500, applied stays 2000 (credit 500)", s[0]!.amount_cents === 1500 && s[0]!.applied === 2000);
    check("collapsedToUnsplit FALSE on unsplit edit", res.collapsedToUnsplit === false);
  });

  // R4+R7 — split draft decrease empties tail → cascade delete + collapse to unsplit.
  await scenario(client, "R4/R7 decrease empties tail → collapse", async (db) => {
    await seedBill(client, "de_b", 2000); await markSplit(client, "de_b", "de_b", 1);
    await seedWire(client, "de_w1", "draft", 2000); await seedApp(client, "de_a1", "de_w1", "de_b", 2000, 1);
    await seedBill(client, "de_c", 1000); await markSplit(client, "de_c", "de_b", 2);
    await seedWire(client, "de_w2", "draft", 1000); await seedApp(client, "de_a2", "de_w2", "de_c", 1000, 2);
    const res = await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 2000, source: "manual_edit" });
    const s = await state(client, "de_b");
    check("collapsed to 1 unsplit row", s.length === 1 && s[0]!.split_group_id === null);
    check("root amount 2000 intact", s[0]!.amount_cents === 2000 && s[0]!.applied === 2000);
    check("result.collapsedToUnsplit", res.collapsedToUnsplit === true);
    check("child deleted, w2 → 0", (await wireAmt(client, "de_w2")) === 0);
  });

  // R4 — cascade past emptied draft into a confirmed partial → confirmed credit.
  await scenario(client, "R4 cascade into confirmed → credit", async (db) => {
    await seedBill(client, "de_b", 2000); await markSplit(client, "de_b", "de_b", 1);
    await seedWire(client, "de_w1", "confirmed", 2000); await seedApp(client, "de_a1", "de_w1", "de_b", 2000, 1);
    await seedBill(client, "de_c", 1000); await markSplit(client, "de_c", "de_b", 2);
    await seedWire(client, "de_w2", "draft", 1000); await seedApp(client, "de_a2", "de_w2", "de_c", 1000, 2);
    await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 500, source: "manual_edit" });
    const s = await state(client, "de_b");
    check("collapsed to 1 row", s.length === 1 && s[0]!.split_group_id === null);
    check("root amount 500, applied stays 2000 (credit 1500)", s[0]!.amount_cents === 500 && s[0]!.applied === 2000);
  });

  // R9 degenerate — decrease unsplit draft to exactly 0 → app removed, root stays 0.
  await scenario(client, "decrease draft to 0", async (db) => {
    await seedBill(client, "de_b", 1000); await seedWire(client, "de_w", "draft", 1000);
    await seedApp(client, "de_a", "de_w", "de_b", 1000, 1);
    await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 0, source: "manual_edit" });
    const s = await state(client, "de_b");
    check("1 row amount 0, no app", s.length === 1 && s[0]!.amount_cents === 0 && s[0]!.applied === null);
    check("wire → 0", (await wireAmt(client, "de_w")) === 0);
  });

  // Unsplit unassigned increase → amount only.
  await scenario(client, "unsplit unassigned increase", async (db) => {
    await seedBill(client, "de_b", 1000);
    await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 1500, source: "manual_edit" });
    const s = await state(client, "de_b");
    check("amount 1500, no app, unsplit", s.length === 1 && s[0]!.amount_cents === 1500 && s[0]!.applied === null && s[0]!.split_group_id === null);
  });

  // Guard — target < 0 rejects.
  await scenario(client, "guard target<0 rejects", async (db) => {
    await seedBill(client, "de_b", 1000);
    let threw = false;
    try { await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: -5, source: "manual_edit" }); }
    catch { threw = true; }
    check("threw on negative target", threw);
  });

  // Guard — bank_fee rejects.
  await scenario(client, "guard bank_fee rejects", async (db) => {
    await seedBill(client, "de_b", 1000, "bank_fee");
    let threw = false;
    try { await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 2000, source: "manual_edit" }); }
    catch { threw = true; }
    check("threw on bank_fee", threw);
  });

  // Guard — pre-backfill multi-application bill rejects (defensive).
  await scenario(client, "guard multi-application rejects", async (db) => {
    await seedBill(client, "de_b", 3000);
    await seedWire(client, "de_w1", "draft", 2000); await seedApp(client, "de_a1", "de_w1", "de_b", 2000, 1);
    await seedWire(client, "de_w2", "draft", 1000); await seedApp(client, "de_a2", "de_w2", "de_b", 1000, 2);
    let threw = false;
    try { await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 3500, source: "manual_edit" }); }
    catch { threw = true; }
    check("threw on >1 application", threw);
  });

  // Guard — partial draft application (applied != amount) rejects (defensive).
  await scenario(client, "guard partial-draft app rejects", async (db) => {
    await seedBill(client, "de_b", 1000);
    await seedWire(client, "de_w", "draft", 400); await seedApp(client, "de_a", "de_w", "de_b", 400, 1);
    let threw = false;
    try { await applyBillTotalChange(db, { billId: "de_b", targetTotalCents: 500, source: "manual_edit" }); }
    catch { threw = true; }
    check("threw on partial draft app", threw);
  });

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  await client.end();
  process.exitCode = fail === 0 ? 0 : 1;
}

void main();
