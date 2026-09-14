/**
 * create-bank-check — crea y postea UN Check / Expense del POS (`gl_check`) desde la
 * terminal: asiento en el libro + encolado a QuickBooks (CheckAdd por el pipeline, desde
 * `842eb0c8`). Es la misma función que usa la pantalla Banking → Checks & Expenses.
 *
 * Caso que lo motivó (conciliación Chase 7223, 2026-09-14): dos líneas del banco sin
 * asiento (compra BADUDI $9,45 + fee $0,28) que el contador mandó a Office Supplies, y
 * el operador no quiere cargarlas a mano ni en el POS ni en QB.
 *
 *   ECOPOWERTECH_ENV=… DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/ledger/create-bank-check.ts \
 *     --mask 7223 --day 2026-06-26 --payee "Badudi Com" [--payee-type vendor --payee-id <qb_vendor.id>] [--number Debit] \
 *     --memo "…" --line "<account_list_id>:<dólares>:<memo>" [--line …] [--actor email] [--apply]
 *
 * DRY-RUN por default: resuelve banco y cuentas, muestra el documento y no escribe. `--apply`
 * crea el draft, lo postea y muestra el resultado del encolado a QB.
 */
import { getDbPool } from "../../api/utils/db-pool";
import { createBankCheck, postBankCheck } from "../../lib/ledger";
import type { BankCheckLineInput, CheckPayeeType } from "../../lib/ledger/documents/bank-check-read";

function parseArgs(argv: string[]) {
  const values = (flag: string): string[] =>
    argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const one = (flag: string): string | null => values(flag)[0] ?? null;
  const mask = one("--mask"),
    day = one("--day"),
    payee = one("--payee");
  if (!mask || !day || !payee) throw new Error("usage: --mask <4 dígitos> --day YYYY-MM-DD --payee <nombre> --line acct:dólares:memo [--apply]");
  const lines = values("--line").map((raw) => {
    const [account, dollars, ...memo] = raw.split(":");
    if (!account || !dollars || !/^-?\d+(\.\d{1,2})?$/.test(dollars)) throw new Error(`--line espera acct:dólares:memo, recibió ${raw}`);
    return { account, cents: BigInt(Math.round(Number(dollars) * 100)), memo: memo.join(":") || null };
  });
  if (!lines.length) throw new Error("falta al menos un --line");
  return {
    mask,
    day,
    payee,
    payeeType: (one("--payee-type") ?? "other") as CheckPayeeType,
    payeeId: one("--payee-id"),
    /** customer_id para TODAS las líneas (refund contra Accounts Receivable: QB exige CustomerRef en la línea de AR). */
    customer: one("--customer"),
    number: one("--number"),
    memo: one("--memo"),
    actor: one("--actor") ?? "a.vargas@ecopowertech.com",
    apply: argv.includes("--apply"),
    lines,
  };
}

const money = (c: bigint): string => (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [args.actor])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${args.actor}`);
  const bank = (
    await pool.query<{ qb_list_id: string; name: string }>(
      `SELECT a.qb_list_id, q.name FROM bank_account a JOIN qb_account q ON q.qb_list_id=a.qb_list_id
        WHERE a.mask=$1 AND a.is_selected AND a.deleted_at IS NULL`,
      [args.mask]
    )
  ).rows;
  if (bank.length !== 1) throw new Error(`*${args.mask}: ${bank.length} cuentas mapeadas (esperaba 1)`);
  const accounts = new Map(
    (
      await pool.query<{ qb_list_id: string; name: string; account_type: string }>(
        `SELECT qb_list_id,name,account_type FROM qb_account WHERE qb_list_id = ANY($1::text[])`,
        [args.lines.map((l) => l.account)]
      )
    ).rows.map((r) => [r.qb_list_id, r])
  );
  if (args.customer || args.payeeType === "customer") {
    const id = args.customer ?? args.payeeId ?? "";
    const c = (await pool.query<{ qb: string | null; name: string | null }>(`SELECT metadata->>'qb_list_id' AS qb, coalesce(company_name, first_name||' '||last_name) AS name FROM customer WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
    if (!c) throw new Error(`customer ${id}: no encontrado`);
    if (!c.qb) throw new Error(`customer ${c.name} sin qb_list_id`);
    console.log(`customer ${c.name} · ListID ${c.qb}`);
  }
  if (args.payeeType === "vendor") {
    // El CheckAdd va con PayeeEntityRef: el vendor tiene que existir en QB con ListID real
    // (uno `pending_` = alta todavía no confirmada → el pipeline lo rechaza como estructural).
    const v = (await pool.query<{ qb_list_id: string; full_name: string }>(`SELECT qb_list_id, full_name FROM qb_vendor WHERE id=$1 AND deleted_at IS NULL`, [args.payeeId ?? ""])).rows[0];
    if (!v) throw new Error(`--payee-id ${args.payeeId}: vendor no encontrado`);
    if (v.qb_list_id.startsWith("pending_")) throw new Error(`vendor "${v.full_name}" todavía sin ListID en QuickBooks (${v.qb_list_id}); esperar al poller`);
    console.log(`vendor ${v.full_name} · ListID ${v.qb_list_id}`);
  }
  const total = args.lines.reduce((s, l) => s + l.cents, 0n);
  console.log(`${args.number ? "Check" : "Expense"} · ${args.day} · ${bank[0]!.name} (*${args.mask}) · pagado a "${args.payee}" (${args.payeeType})${args.memo ? ` · memo "${args.memo}"` : ""}`);
  for (const l of args.lines) {
    const a = accounts.get(l.account);
    if (!a) throw new Error(`cuenta ${l.account} no existe en qb_account`);
    console.log(`  ${a.name.padEnd(40)} ${money(l.cents).padStart(12)}  ${l.memo ?? ""}`);
  }
  console.log(`  ${"TOTAL (Cr banco)".padEnd(40)} ${money(total).padStart(12)}`);
  if (!args.apply) {
    console.log("DRY-RUN: no se escribió nada. Usá --apply.");
    return;
  }
  const client = await pool.connect();
  try {
    const lines: BankCheckLineInput[] = args.lines.map((l) => ({ account_list_id: l.account, amount_cents: l.cents, memo: l.memo, customer_id: args.customer, billable: false }));
    const check = await createBankCheck(
      client,
      {
        day: args.day,
        bank_account_list_id: bank[0]!.qb_list_id,
        number: args.number,
        payee_type: args.payeeType,
        payee_id: args.payeeId,
        payee_name: args.payee,
        memo: args.memo,
        to_be_printed: false,
        lines,
      },
      actor.id
    );
    console.log(`creado ${check.doc_number} (${check.id}, ${check.kind}, ${check.status})`);
    const posted = await postBankCheck(client, check.id, actor.id);
    console.log(`posteado: ${posted.status} · asiento ${posted.entry_id} · QB: ${JSON.stringify(posted.qb)}`);
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("create-bank-check:", error instanceof Error ? error.message : error, (error as { details?: unknown })?.details ?? "");
    process.exit(1);
  });
