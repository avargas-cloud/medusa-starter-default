/**
 * verify-ledger-docs — afirma los documentos MANUALES del GL (journal entries,
 * checks, transfers, year close) contra una base real, SIN dejar rastro:
 * todo corre dentro de UNA transacción que se ROLLBACKEA al final.
 *
 *   DATABASE_URL=postgresql://… ./node_modules/.bin/tsx src/scripts/verify/verify-ledger-docs.ts
 *
 * Checks:
 *  (a) un check posteado crea EXACTAMENTE un `bank_journal_entry` activo
 *      `source_kind='bank_check'`, balanceado, Dr línea(s) / Cr banco;
 *  (b) postear dos veces es idempotente (`already_posted`, mismo entry_id, 1 asiento);
 *  (c) void → asiento de reversa espejo (misma cuenta/role, lados invertidos)
 *      + documento `voided` con motivo;
 *  (d) postear en un mes cerrado (fila temporal en `accounting_period_close`)
 *      → `GL_PERIOD_CLOSED`;
 *  (e) year close: `net_income_cents` del preview == (Σcr−Σdr Income/OtherIncome)
 *      − (Σdr−Σcr COGS/Expense/OtherExpense) leído del journal con la misma
 *      definición de entrada activa que el trial balance;
 *  (f) no-vacuidad: cada check evaluó ≥1 fila real.
 */
import { Pool, type PoolClient } from "pg";

import {
  createBankCheck,
  getBankCheck,
  postBankCheck,
  previewYearClose,
  voidBankCheck,
  LedgerError,
} from "../../lib/ledger";

if (!process.env.DATABASE_URL) {
  console.error("uso: DATABASE_URL=… tsx src/scripts/verify/verify-ledger-docs.ts");
  process.exit(2);
}

let failures = 0;
let evaluated = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  evaluated += 1;
}

type Line = { role: string; account_list_id: string; debit_cents: string; credit_cents: string };
async function entryLines(client: PoolClient, entryId: string): Promise<Line[]> {
  const { rows } = await client.query<Line>(
    `SELECT role, account_list_id, debit_cents::text, credit_cents::text FROM bank_journal_line WHERE entry_id = $1 ORDER BY role`,
    [entryId]
  );
  return rows;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const ACTOR = "verify-ledger-docs";
  try {
    await client.query("BEGIN");
    console.log("verify-ledger-docs (todo dentro de una transacción; ROLLBACK al final)");

    const { rows: banks } = await client.query<{ qb_list_id: string }>(
      `SELECT qb_list_id FROM qb_account WHERE account_type = 'Bank' AND is_active AND deleted_at IS NULL ORDER BY full_name LIMIT 1`
    );
    const { rows: expenses } = await client.query<{ qb_list_id: string }>(
      `SELECT qb_list_id FROM qb_account WHERE account_type = 'Expense' AND is_active AND deleted_at IS NULL ORDER BY full_name LIMIT 2`
    );
    const bank = banks[0]?.qb_list_id;
    const [exp1, exp2] = expenses.map((r) => r.qb_list_id);
    if (!bank || !exp1 || !exp2) throw new Error("loader vacío: hacen falta 1 Bank + 2 Expense activas");

    // Un día abierto: hoy (ET) — ningún mes cerrado puede contener hoy sin
    // bloquear al POS entero, así que es el día seguro para (a)-(c).
    const { rows: today } = await client.query<{ d: string }>(
      `SELECT to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS d`
    );
    const day = today[0]!.d;

    // (a) ────────────────────────────────────────────────────────────────
    const created = await createBankCheck(
      client,
      {
        day, bank_account_list_id: bank, number: "9001", payee_type: "other", payee_name: "verify-ledger-docs",
        lines: [{ account_list_id: exp1, amount_cents: 1_000n }, { account_list_id: exp2, amount_cents: 234n }],
      },
      ACTOR
    );
    check("(a) draft creado con kind=check y total 1234", created.status === "draft" && created.kind === "check" && created.total_cents === 1234, JSON.stringify({ kind: created.kind, total: created.total_cents, doc: created.doc_number }));
    const posted = await postBankCheck(client, created.id, ACTOR);
    const { rows: active } = await client.query<{ id: string; amount_cents: string; day: string }>(
      `SELECT e.id, e.amount_cents::text, e.day FROM bank_journal_entry e
       WHERE e.source_kind = 'bank_check' AND e.source_id = $1 AND e.kind = 'document' AND e.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)`,
      [created.id]
    );
    check("(a) exactamente un asiento activo bank_check", active.length === 1 && active[0]!.id === posted.entry_id, `${active.length} activos`);
    const lines = await entryLines(client, posted.entry_id);
    const dr = lines.reduce((a, l) => a + BigInt(l.debit_cents), 0n);
    const cr = lines.reduce((a, l) => a + BigInt(l.credit_cents), 0n);
    check("(a) balanceado y amount = 1234", dr === cr && dr === 1234n && active[0]?.amount_cents === "1234", `D${dr} C${cr}`);
    const bankLine = lines.find((l) => l.role === "bank_account");
    const item1 = lines.find((l) => l.role === "item_1");
    const item2 = lines.find((l) => l.role === "item_2");
    check(
      "(a) Dr item_1(1000)/item_2(234) contra sus cuentas, Cr bank_account(1234) contra el banco",
      bankLine?.account_list_id === bank && bankLine.credit_cents === "1234" && bankLine.debit_cents === "0" &&
        item1?.account_list_id === exp1 && item1.debit_cents === "1000" && item1.credit_cents === "0" &&
        item2?.account_list_id === exp2 && item2.debit_cents === "234" && lines.length === 3,
      lines.map((l) => `${l.role}:${l.account_list_id} D${l.debit_cents}/C${l.credit_cents}`).join(" · ")
    );
    const afterPost = await getBankCheck(client, created.id);
    check("(a) documento posted con entry_id", afterPost?.status === "posted" && afterPost.entry_id === posted.entry_id);

    // (b) ────────────────────────────────────────────────────────────────
    const again = await postBankCheck(client, created.id, ACTOR);
    const { rows: countAfter } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_journal_entry WHERE source_kind = 'bank_check' AND source_id = $1`,
      [created.id]
    );
    check("(b) segundo post → already_posted, mismo entry_id, sigue 1 asiento", again.status === "already_posted" && again.entry_id === posted.entry_id && countAfter[0]?.n === "1", `${again.status} · ${countAfter[0]?.n} asientos`);

    // (c) ────────────────────────────────────────────────────────────────
    const voided = await voidBankCheck(client, created.id, "verify: void", ACTOR);
    const { rows: reversal } = await client.query<{ id: string; day: string }>(
      `SELECT id, day FROM bank_journal_entry WHERE reverses_entry_id = $1`,
      [posted.entry_id]
    );
    const mirror = reversal[0] ? await entryLines(client, reversal[0].id) : [];
    const mirrors = mirror.length === lines.length && lines.every((o) => {
      const m = mirror.find((x) => x.role === o.role);
      return m && m.account_list_id === o.account_list_id && m.debit_cents === o.credit_cents && m.credit_cents === o.debit_cents;
    });
    check("(c) void → una reversa espejo (misma cuenta/role, lados invertidos)", reversal.length === 1 && mirrors, `${reversal.length} reversas, ${mirror.length} líneas`);
    check("(c) documento voided con motivo", voided.status === "voided" && voided.void_reason === "verify: void" && voided.voided_at !== null);

    // (d) ────────────────────────────────────────────────────────────────
    const { rows: closedRow } = await client.query<{ period_start: string }>(
      `INSERT INTO accounting_period_close (id, period_start, period_end, revision, status, summary, open_documents, readiness, closed_by_user_id)
       VALUES ('apc_verify_ledger_docs', '2020-01-01', '2020-02-01', 1, 'closed', '{}', '[]', '{}', $1)
       RETURNING period_start::text`,
      [ACTOR]
    );
    const draftClosed = await createBankCheck(
      client,
      { day: "2020-01-15", bank_account_list_id: bank, payee_type: "other", payee_name: "closed-period", lines: [{ account_list_id: exp1, amount_cents: 1n }] },
      ACTOR
    );
    let closedCode: string | null = null;
    try {
      await postBankCheck(client, draftClosed.id, ACTOR);
    } catch (err) {
      closedCode = err instanceof LedgerError ? err.code : String(err);
    }
    const stillDraft = await getBankCheck(client, draftClosed.id);
    check("(d) post en mes cerrado → GL_PERIOD_CLOSED y el draft queda draft", closedRow.length === 1 && closedCode === "GL_PERIOD_CLOSED" && stillDraft?.status === "draft", `code=${closedCode} status=${stillDraft?.status}`);

    // (e) ────────────────────────────────────────────────────────────────
    const year = day.slice(0, 4);
    const preview = await previewYearClose(client, year);
    const { rows: tb } = await client.query<{ income: string; expense: string; n: string }>(
      `SELECT COALESCE(SUM(CASE WHEN a.account_type IN ('Income','OtherIncome') THEN l.credit_cents - l.debit_cents ELSE 0 END), 0)::text AS income,
              COALESCE(SUM(CASE WHEN a.account_type IN ('CostOfGoodsSold','Expense','OtherExpense') THEN l.debit_cents - l.credit_cents ELSE 0 END), 0)::text AS expense,
              count(*)::text AS n
       FROM bank_journal_line l
       JOIN bank_journal_entry e ON e.id = l.entry_id
       JOIN qb_account a ON a.qb_list_id = l.account_list_id
       WHERE l.deleted_at IS NULL AND e.deleted_at IS NULL AND e.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
         AND e.source_kind IS DISTINCT FROM 'year_close'
         AND e.day >= $1 AND e.day <= $2`,
      [`${year}-01-01`, `${year}-12-31`]
    );
    const tbNet = BigInt(tb[0]!.income) - BigInt(tb[0]!.expense);
    check(`(e) year close ${year}: net_income del preview == TB income − expense`, BigInt(preview.net_income_cents) === tbNet && BigInt(preview.income_cents) === BigInt(tb[0]!.income), `preview ${preview.net_income_cents} vs TB ${tbNet} (${tb[0]!.n} líneas P&L, ${preview.accounts.length} cuentas)`);
    check("(e) retained_earnings mapeada y status coherente", preview.retained_earnings !== null && (preview.status === "posted") === (preview.entry_id !== null), `${preview.status} re=${preview.retained_earnings?.name}`);

    // (f) ────────────────────────────────────────────────────────────────
    check("(f) no-vacuidad: (a) evaluó 3 líneas, (c) evaluó una reversa, (e) evaluó ≥1 línea P&L", lines.length === 3 && mirror.length === 3 && Number(tb[0]!.n) > 0, `P&L lines=${tb[0]!.n}`);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
  console.log(failures ? `\n✗ ${failures}/${evaluated} checks fallaron (rollback hecho)` : `\n✓ ${evaluated}/${evaluated} checks OK (rollback hecho)`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
