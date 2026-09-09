/** Exact approved v9 sandbox entrypoint: snapshot, schema and real repeatable E2E. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { configureBankSandbox } from "../../lib/banking/sandbox-runtime";
import { getDbPool } from "../../api/utils/db-pool";
import { receiptSnapshot, seedLegacyJournal, cleanReceiptFixtures, cleanLegacyProbe, fingerprints, bankingFingerprint } from "../tests/bank-receipts-fixtures";
import { transaction } from "../../lib/banking/store";
import { withReviewLock } from "../../lib/banking/review-common";
import { Migration20260909040000 } from "../../modules/banking/migrations/Migration20260909040000";
import { journalNegativeControls } from "../tests/bank-accounting-fixtures";

async function main() {
  assert.equal(process.argv.length, 2, "Run the approved entrypoint without flags");
  configureBankSandbox();
  const pool = getDbPool(); const client = await pool.connect();
  try {
    assert(!(await client.query("SELECT to_regclass('public.bank_opening_balance') name")).rows[0].name,
      "V10 schema present: use verify-bank-openings.ts; replaying v9 functions would remove opening source guards");
    const target = (await client.query("SELECT current_database() db,inet_server_port() port")).rows[0];
    assert.equal(target.db, "medusa");
    const columns = (await client.query(`SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='customer_payment' ORDER BY ordinal_position`)).rows;
    const triggers = (await client.query(`SELECT t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition,p.proname,
      pg_get_functiondef(p.oid) function_definition FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='customer_payment'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`)).rows;
    assert(columns.some(row => row.column_name === "raw_amount" && row.is_nullable === "NO"));
    assert(triggers.length === 1 && triggers[0].tgname === "trg_order_money_payment" && triggers[0].tgenabled === "O");
    assert(triggers[0].function_definition.includes("WHERE x IS NOT NULL"), "Orderless fixtures cannot mutate financial order projections");
    console.log("PASS v9 source schema and orderless fixture trigger preflight");
    await receiptSnapshot(client);
    const sourcesBefore = await fingerprints(client);
    // Recover only orphan command receipts carrying this harness's account AND reference identity.
    await transaction(client, async () => {
      await withReviewLock(client);
      const orphan = await client.query(`SELECT id FROM bank_review_event WHERE entity_type='command' AND action='deposit_save'
        AND result->'deposit'->>'account_id'='bank_e2e_receipts_v9_account'
        AND starts_with(result->'deposit'->>'reference','bank_e2e_receipts_v9_')
        AND NOT EXISTS(SELECT 1 FROM bank_deposit d WHERE d.id=bank_review_event.result->'deposit'->>'id')`);
      assert(orphan.rowCount!<=100);
      if(orphan.rowCount) { await client.query("DELETE FROM bank_review_event WHERE id=ANY($1::text[])",[orphan.rows.map(row=>row.id)]);
        console.log(`PASS recovered ${orphan.rowCount} identified own orphan command receipt`); }
    });
    const banksBefore = await bankingFingerprint(client);
    const ready = Boolean((await client.query("SELECT to_regclass('public.bank_accounting_setup') AS name")).rows[0].name);
    if (!ready) {
      let owns = false;
      try {
        assert(!(await client.query("SELECT 1 FROM bank_connection WHERE id='bank_e2e_receipts_v9_connection'")).rowCount,
          "No unresolved fixture from an interrupted pre-migration run");
        owns = true;
        const id = await seedLegacyJournal(client);
        const oldFields = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
          AND table_name='bank_journal_entry' ORDER BY ordinal_position`)).rows.map(row => String(row.column_name));
        assert(oldFields.every(name => /^[a-z_]+$/.test(name)));
        const legacy = async () => (await client.query(`SELECT ${oldFields.join(",")} FROM bank_journal_entry WHERE id=$1`, [id])).rows;
        const lineState = async () => (await client.query("SELECT * FROM bank_journal_line WHERE entry_id=$1 ORDER BY id", [id])).rows;
        const before = await legacy(); const linesBefore = await lineState();
        const migration = Object.create(Migration20260909040000.prototype) as Migration20260909040000;
        const statements: string[] = []; migration.addSql = (sql: string) => { statements.push(sql); };
        await migration.up();
        await transaction(client, async () => {
          await withReviewLock(client);
          for (const [index, sql] of statements.entries()) {
            try { await client.query(sql); }
            catch (error) {
              const detail = error as { message?: string; where?: string; position?: string };
              throw new Error(`V9 migration statement ${index + 1}: ${detail.message}; position=${detail.position ?? "none"}; ${detail.where ?? ""}`);
            }
          }
        });
        assert.deepEqual(await legacy(), before, "Every pre-v9 journal column preserved after ALTER");
        assert.deepEqual(await lineState(), linesBefore, "Legacy v8 accounts, signs and immutable snapshots preserved");
        console.log(`PASS v9 migration preserves nonempty v8 journal; ${await journalNegativeControls(client, id)} v8 PG negatives still enforced`);
      } finally {
        if (owns) {
          const migrated = Boolean((await client.query("SELECT to_regclass('public.bank_accounting_setup') AS name")).rows[0].name);
          if (migrated) await cleanReceiptFixtures(client); else await cleanLegacyProbe(client);
        }
      }
      const banksAfter = await bankingFingerprint(client);
      for (const name of Object.keys(banksBefore)) assert.deepEqual(banksAfter[name], banksBefore[name], `Pre-v9 ${name} rows preserved`);
    }
    // Homologate the three reviewed v9 functions if an earlier sandbox-only iteration already applied CREATE TABLE.
    // No legacy row is rewritten; the same function definitions are shipped by the new migration.
    const finalMigration = Object.create(Migration20260909040000.prototype) as Migration20260909040000;
    const finalSql: string[] = []; finalMigration.addSql = (sql: string) => { finalSql.push(sql); }; await finalMigration.up();
    await transaction(client, async () => {
      await withReviewLock(client);
      await client.query(`ALTER TABLE bank_journal_entry DROP CONSTRAINT bank_journal_reverse_shape;
        ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_reverse_shape CHECK(
          (kind<>'reversal' AND reverses_entry_id IS NULL AND reason IS NULL) OR
          (kind='reversal' AND reverses_entry_id IS NOT NULL AND reason IS NOT NULL AND length(trim(reason))>0))`);
      await client.query(finalSql[1]!.split("CREATE TRIGGER")[0]!);
      await client.query(finalSql[3]!);
      await client.query(finalSql[4]!.split("CREATE CONSTRAINT TRIGGER")[0]!);
    });
    assert.deepEqual(await fingerprints(client), sourcesBefore, "Migration and legacy fixture cleanup preserve protected financial sources");
    console.log("PASS v9 final schema functions and protected-source fingerprints");
  } finally { client.release(); await pool.end(); }
  const backend = resolve(__dirname,"../../.."), loader = resolve(backend,"node_modules/tsx/dist/loader.mjs");
  const run = (script: string) => execFileSync(process.execPath,["--import",loader,resolve(backend,script)],
    {cwd:backend,env:process.env,stdio:"inherit",timeout:300000});
  run("src/scripts/tests/e2e-bank-receipts-sandbox.ts");
  run("src/scripts/tests/e2e-bank-receipts-sandbox.ts");
  run("src/scripts/tests/e2e-bank-accounting-sandbox.ts");
  run("src/scripts/verify/verify-bank-deposits.ts");
  run("src/scripts/tests/e2e-bank-matches-sandbox.ts");
  console.log("PASS v9 verifier: two clean E2E runs and v7/v8 regressions");
}
void main().catch((error: unknown) => {
  console.error("BANK_RECEIPTS_VERIFICATION_FAILED", error instanceof Error ? error.message : "UNKNOWN_ERROR");
  process.exitCode = 1;
});
