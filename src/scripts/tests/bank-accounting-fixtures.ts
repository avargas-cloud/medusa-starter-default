/** V8-owned banking evidence only; financial source documents are fingerprinted read-only. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PoolClient } from "pg";

import { withReviewLock } from "../../lib/banking/review-common";
import { transaction } from "../../lib/banking/store";

export const connection = "bconn_e2e_accounting_v8";
export const account = "bacc_e2e_accounting_v8";
/** Cuenta acompanante SIN configurar: la regla bajo prueba es que un dia no cierra
 *  mientras alguna cuenta aplicable carezca de setup. Antes dependia de una cuenta
 *  ambiental (la conexion Plaid Sandbox de v3) que el bootstrap de esquema vacio borro,
 *  y el check quedaba vacuo/rojo segun la maquina. El fixture ahora la crea. */
export const companionAccount = "bacc_e2e_accounting_v8_companion";
export const prefix = "btx_e2e_accounting_v8_";
export const actor = "e2e_accounting_v8_actor";
export const day = "2026-08-17";
export const laterDay = "2026-09-08";
export const closeNote = "EPT owned accounting v8 verification";
export const protectedTables = [
  "customer_payment",
  "payment_application",
  "pos_invoice",
  "pos_credit_memo",
  "vendor_bill",
  "qb_account",
  "treasury_distribution_log",
  "qb_order_pipeline",
];

export async function fingerprints(client: PoolClient) {
  const extra = await client.query<{
    tablename: string;
  }>(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND (tablename LIKE 'china_%' OR tablename LIKE '%payroll%' OR tablename LIKE 'treasury_%'
      OR tablename IN ('china_payment','china_wire','china_expense','inventory_level','product_variant')) ORDER BY tablename`);
  const tables = [
    ...new Set([...protectedTables, ...extra.rows.map((row) => row.tablename)]),
  ].sort();
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    assert(/^[a-z_]+$/.test(table));
    result[table] = (
      await client.query(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)::text),'')) AS hash FROM ${table} t`)
    ).rows[0];
  }
  return result;
}
export async function bankingFingerprint(client: PoolClient) {
  const result: Record<string, unknown> = {};
  const tables = (
    await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND starts_with(tablename,'bank_') ORDER BY tablename"
    )
  ).rows;
  for (const { tablename } of tables) {
    assert(/^[a-z_]+$/.test(tablename));
    result[tablename] = (
      await client.query(`SELECT count(*)::text AS count,
      md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY to_jsonb(t)::text),'')) AS hash FROM ${tablename} t`)
    ).rows[0];
  }
  return result;
}

export async function verifiedSnapshot(client: PoolClient) {
  const file = resolve(
    __dirname,
    "../../../../sandbox-artifacts/snapshots/pre-bank-accounting-v8.dump"
  );
  const before = await fingerprints(client);
  if (!existsSync(file)) {
    assert(
      !(
        await client.query(
          "SELECT to_regclass('public.bank_journal_entry') AS name"
        )
      ).rows[0].name,
      "First v8 snapshot must precede the v8 migration"
    );
    const bytes = execFileSync(
      "sg",
      [
        "docker",
        "-c",
        "docker exec sb_postgres pg_dump -U postgres -d medusa -Fc",
      ],
      { maxBuffer: 256 * 1024 * 1024 }
    );
    assert(bytes.length > 1000, "Snapshot archive must contain data");
    writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
    writeFileSync(
      file.replace(/dump$/, "fingerprints.json"),
      JSON.stringify(before, null, 2),
      { mode: 0o600, flag: "wx" }
    );
  }
  const toc = await new Promise<string>((done, reject) => {
    const child = spawn(
      "sg",
      ["docker", "-c", "docker exec -i sb_postgres pg_restore --list"],
      { stdio: ["pipe", "pipe", "ignore"] }
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code) =>
      code === 0
        ? done(Buffer.concat(chunks).toString())
        : reject(new Error("SNAPSHOT_TOC_FAILED"))
    );
    child.stdin.end(readFileSync(file));
  });
  for (const table of Object.keys(before))
    assert(toc.includes(` ${table} `), `Snapshot includes ${table}`);
  assert(toc.includes(" bank_transaction "));
  writeFileSync(file.replace(/dump$/, "toc"), toc, { mode: 0o600 });
  assert.deepEqual(
    await fingerprints(client),
    before,
    "Snapshot does not modify protected documents"
  );
  console.log(
    `PASS pre-bank-accounting-v8 snapshot + TOC; ${Object.keys(before).length} protected fingerprints`
  );
}

export async function seedAccount(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    assert(
      !(
        await client.query("SELECT 1 FROM bank_connection WHERE id=$1", [
          connection,
        ])
      ).rowCount
    );
    const caps = (
      await client.query(`SELECT (SELECT count(*) FROM bank_connection)::int AS c,
      (SELECT count(*) FROM bank_account)::int AS a`)
    ).rows[0];
    assert(
      caps.c < 3 && caps.a < 9,
      "Owned fixtures respect connection/account caps for both owned accounts"
    );
    const bank = (
      await client.query(`SELECT qb_list_id FROM qb_account WHERE is_active AND deleted_at IS NULL
      AND account_type='Bank' AND currency IN ('USD','US Dollar') ORDER BY qb_list_id LIMIT 1`)
    ).rows[0];
    assert(bank, "Existing active USD Bank mapping is required");
    await client.query(
      `INSERT INTO bank_connection(id,provider,environment,provider_item_id,status,initial_sync_complete,historical_sync_complete,last_successful_sync_at)
      VALUES($1,'plaid','sandbox',$1,'active',true,true,now())`,
      [connection]
    );
    await client.query(
      `INSERT INTO bank_account(id,connection_id,provider_account_id,name,type,currency,is_selected,qb_list_id,
      review_start_date,opening_bank_balance,opening_balance_date,opening_reference,setup_revision)
      VALUES($1,$2,$1,'EPT Accounting v8 verification','depository','USD',true,$3,'2000-01-01','0','1999-12-31','Synthetic v8 opening',1)`,
      [account, connection, bank.qb_list_id]
    );
    // Sin review_start_date/opening_*: es aplicable a cualquier dia y bloquea el cierre.
    // qb_list_id NULL a proposito (cuenta aun no mapeada), asi no toca uq_bank_account_active_qb
    // ni consume otra cuenta Bank del catalogo QB.
    await client.query(
      `INSERT INTO bank_account(id,connection_id,provider_account_id,name,type,currency,is_selected,setup_revision)
      VALUES($1,$2,$1,'EPT Accounting v8 unconfigured companion','depository','USD',true,0)`,
      [companionAccount, connection]
    );
  });
}

export async function seedMovement(
  client: PoolClient,
  suffix: string,
  amount = "120.01",
  date = day
) {
  const id = prefix + suffix;
  await transaction(client, async () => {
    await withReviewLock(client);
    assert(
      (await client.query("SELECT count(*)::int n FROM bank_transaction"))
        .rows[0].n < 2000
    );
    await client.query(
      `INSERT INTO bank_transaction(id,connection_id,account_id,provider_transaction_id,amount,currency,status,
      transaction_date,name,source_data,first_seen_at,last_seen_at) VALUES($1,$2,$3,$1,$4::numeric,'USD','posted',$5,
      'EPT synthetic direct expense v8','{}',now(),now())`,
      [id, connection, account, amount, date]
    );
  });
  return id;
}

export async function cleanFixtures(client: PoolClient) {
  await transaction(client, async () => {
    await withReviewLock(client);
    // Approved fixture-only DDL. Transactional table lock prevents other writers seeing disabled triggers.
    await client.query(
      "LOCK TABLE bank_journal_entry,bank_journal_line IN ACCESS EXCLUSIVE MODE"
    );
    const triggers = (
      await client.query(`SELECT tgname,tgenabled FROM pg_trigger
      WHERE tgname IN ('bank_journal_entry_immutable','bank_journal_line_immutable') ORDER BY tgname`)
    ).rows;
    assert(
      triggers.length === 2 && triggers.every((row) => row.tgenabled === "O"),
      "Journal guards enabled before cleanup"
    );
    const foreignBefore = (
      await client.query(
        `SELECT md5(COALESCE(string_agg(to_jsonb(e)::text,'' ORDER BY e.id),'')) h
      FROM (SELECT e.id,to_jsonb(e) AS entry,(SELECT jsonb_agg(l ORDER BY l.id) FROM bank_journal_line l WHERE l.entry_id=e.id) AS lines FROM bank_journal_entry e WHERE NOT starts_with(transaction_id,$1)) e`,
        [prefix]
      )
    ).rows;
    await client.query(
      "ALTER TABLE bank_journal_line DISABLE TRIGGER bank_journal_line_immutable"
    );
    await client.query(
      "ALTER TABLE bank_journal_entry DISABLE TRIGGER bank_journal_entry_immutable"
    );
    await client.query(
      `DELETE FROM bank_journal_line WHERE entry_id IN
      (SELECT id FROM bank_journal_entry WHERE starts_with(transaction_id,$1))`,
      [prefix]
    );
    await client.query(
      "DELETE FROM bank_journal_entry WHERE starts_with(transaction_id,$1) AND kind='reversal'",
      [prefix]
    );
    await client.query(
      "DELETE FROM bank_journal_entry WHERE starts_with(transaction_id,$1)",
      [prefix]
    );
    await client.query(
      "ALTER TABLE bank_journal_entry ENABLE TRIGGER bank_journal_entry_immutable"
    );
    await client.query(
      "ALTER TABLE bank_journal_line ENABLE TRIGGER bank_journal_line_immutable"
    );
    assert.deepEqual(
      (
        await client.query(`SELECT tgname,tgenabled FROM pg_trigger
      WHERE tgname IN ('bank_journal_entry_immutable','bank_journal_line_immutable') ORDER BY tgname`)
      ).rows,
      triggers
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT md5(COALESCE(string_agg(to_jsonb(e)::text,'' ORDER BY e.id),'')) h
      FROM (SELECT e.id,to_jsonb(e) AS entry,(SELECT jsonb_agg(l ORDER BY l.id) FROM bank_journal_line l WHERE l.entry_id=e.id) AS lines FROM bank_journal_entry e WHERE NOT starts_with(transaction_id,$1)) e`,
          [prefix]
        )
      ).rows,
      foreignBefore
    );
    await client.query(
      "DELETE FROM bank_direct_expense WHERE starts_with(transaction_id,$1)",
      [prefix]
    );
    const closes = (
      await client.query(
        "SELECT id,inventory_snapshots FROM accounting_period_close WHERE close_note=$1",
        [closeNote]
      )
    ).rows;
    assert(closes.length <= 20);
    const snapshots = closes.flatMap((row) =>
      (row.inventory_snapshots as { snapshotId: string }[]).map(
        (item) => item.snapshotId
      )
    );
    assert(snapshots.length <= 40);
    await client.query(
      "DELETE FROM inventory_valuation_snapshot_line WHERE snapshot_id=ANY($1::text[])",
      [snapshots]
    );
    await client.query(
      "DELETE FROM inventory_valuation_snapshot WHERE id=ANY($1::text[])",
      [snapshots]
    );
    await client.query(
      "DELETE FROM accounting_period_close WHERE id=ANY($1::text[])",
      [closes.map((row) => row.id)]
    );
    await client.query(
      "DELETE FROM bank_review_event WHERE starts_with(transaction_id,$1) OR starts_with(entity_id,$1) OR starts_with(actor_id,$2)",
      [prefix, actor]
    );
    const daily = (
      await client.query(
        `SELECT id,day FROM bank_day_close WHERE day=$1
      AND (snapshot::text LIKE $2 OR history::text LIKE $2)`,
        [day, `%${account}%`]
      )
    ).rows;
    for (const row of daily) {
      await client.query(
        "DELETE FROM bank_review_event WHERE entity_type IN ('day','command') AND entity_id=$1",
        [row.day]
      );
      await client.query("DELETE FROM bank_day_close WHERE id=$1", [row.id]);
    }
    for (const table of ["bank_review_attachment", "bank_transaction_review"])
      await client.query(
        `DELETE FROM ${table} WHERE starts_with(transaction_id,$1)`,
        [prefix]
      );
    await client.query(
      "DELETE FROM bank_review_permission WHERE starts_with(id,'brp_e2e_accounting_v8')"
    );
    for (const table of [
      "bank_webhook_event",
      "bank_sync_run",
      "bank_transaction",
      "bank_account",
    ])
      await client.query(`DELETE FROM ${table} WHERE connection_id=$1`, [
        connection,
      ]);
    await client.query("DELETE FROM bank_connection WHERE id=$1", [connection]);
    assert.equal(
      (
        await client.query(
          `SELECT 1 FROM bank_journal_entry WHERE starts_with(transaction_id,$1) UNION ALL
      SELECT 1 FROM bank_direct_expense WHERE starts_with(transaction_id,$1) UNION ALL SELECT 1 FROM bank_transaction WHERE starts_with(id,$1)
      UNION ALL SELECT 1 FROM bank_review_event WHERE starts_with(transaction_id,$1) OR starts_with(entity_id,$1) OR starts_with(actor_id,$2)`,
          [prefix, actor]
        )
      ).rowCount,
      0
    );
  });
}

export async function journalNegativeControls(
  client: PoolClient,
  entryId: string
) {
  for (const table of ["bank_journal_entry", "bank_journal_line"]) {
    const where = table === "bank_journal_entry" ? "id=$1" : "entry_id=$1";
    await assert.rejects(
      client.query(`DELETE FROM ${table} WHERE ${where}`, [entryId]),
      /BANKING_JOURNAL_IMMUTABLE/
    );
  }
  const copy = `INSERT INTO bank_journal_entry(id,expense_id,transaction_id,kind,day,currency,amount_cents,
    source_hash,source_snapshot,reference,description,actor_id,reverses_entry_id,reason)
    SELECT 'bje_e2e_accounting_v8_negative',expense_id,transaction_id,$2,day,currency,amount_cents,
      source_hash,source_snapshot,reference,description,actor_id,CASE WHEN $2='reversal' THEN id ELSE NULL END,
      CASE WHEN $2='reversal' THEN 'Owned invalid journal probe' ELSE NULL END
    FROM bank_journal_entry WHERE id=$1`;
  await assert.rejects(
    transaction(client, async () => {
      await client.query(copy, [entryId, "expense"]);
    }),
    /BANKING_ALREADY_POSTED/
  );
  await assert.rejects(
    transaction(client, async () => {
      await client.query(
        copy.replace("expense_id,transaction_id,$2", "expense_id,$3,$2"),
        [entryId, "expense", prefix + "wrong_join"]
      );
    }),
    /BANKING_JOURNAL_SOURCE_INVALID/
  );
  for (const lines of [0, 1, 2]) {
    await assert.rejects(
      transaction(client, async () => {
        await client.query(copy, [entryId, "reversal"]);
        if (lines)
          await client.query(
            `INSERT INTO bank_journal_line(id,entry_id,role,account_list_id,account_snapshot,debit_cents,credit_cents)
        SELECT 'bjl_e2e_accounting_v8_'||role,'bje_e2e_accounting_v8_negative',role,account_list_id,account_snapshot,
          CASE WHEN credit_cents>0 THEN credit_cents + CASE WHEN $2=2 THEN 1 ELSE 0 END ELSE 0 END,debit_cents
        FROM bank_journal_line WHERE entry_id=$1 ORDER BY role LIMIT $2`,
            [entryId, lines]
          );
      }),
      /BANKING_JOURNAL_UNBALANCED/
    );
  }
  assert.equal(
    (
      await client.query(
        "SELECT 1 FROM bank_journal_entry WHERE id='bje_e2e_accounting_v8_negative'"
      )
    ).rowCount,
    0
  );
  return 8;
}
