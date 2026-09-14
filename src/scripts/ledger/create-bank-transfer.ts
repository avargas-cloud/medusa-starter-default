/**
 * create-bank-transfer — crea y postea UN Transfer del POS (`gl_transfer`) desde la terminal:
 * asiento en el libro + encolado a QuickBooks (TransferAdd por el pipeline, desde `842eb0c8`).
 * Misma función que Banking → Transfers.
 *
 * Caso que lo motivó (Chase 7223, agosto 2026): retiro de $500 en el ATM y depósito de los
 * mismos $500 el mismo día (cambio de billetes fallido) — dos transfers Chase ↔ Petty Cash
 * para que cada línea del banco tenga su asiento (contador, pregunta 4 = A, 2026-09-14).
 *
 *   ECOPOWERTECH_ENV=… DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/ledger/create-bank-transfer.ts \
 *     --day 2026-08-24 --from <account_list_id> --to <account_list_id> --amount 500.00 --memo "…" [--actor email] [--apply]
 *
 * DRY-RUN por default. `--apply` crea el draft, lo postea y muestra el encolado a QB.
 */
import { getDbPool } from "../../api/utils/db-pool";
import { createBankTransfer, postBankTransfer } from "../../lib/ledger";

function parseArgs(argv: string[]) {
  const one = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const day = one("--day"),
    from = one("--from"),
    to = one("--to"),
    amount = one("--amount");
  if (!day || !from || !to || !amount || !/^\d+(\.\d{1,2})?$/.test(amount))
    throw new Error("usage: --day YYYY-MM-DD --from <list_id> --to <list_id> --amount dólares [--memo …] [--apply]");
  return {
    day,
    from,
    to,
    cents: BigInt(Math.round(Number(amount) * 100)),
    memo: one("--memo"),
    actor: one("--actor") ?? "a.vargas@ecopowertech.com",
    apply: argv.includes("--apply"),
  };
}

const money = (c: bigint): string => (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [args.actor])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${args.actor}`);
  const accounts = new Map(
    (await pool.query<{ qb_list_id: string; name: string; account_type: string }>(`SELECT qb_list_id,name,account_type FROM qb_account WHERE qb_list_id = ANY($1::text[])`, [[args.from, args.to]])).rows.map((r) => [r.qb_list_id, r])
  );
  const from = accounts.get(args.from),
    to = accounts.get(args.to);
  if (!from || !to) throw new Error(`cuenta no encontrada: ${!from ? args.from : args.to}`);
  console.log(`Transfer · ${args.day} · ${from.name} (${from.account_type}) → ${to.name} (${to.account_type}) · ${money(args.cents)}${args.memo ? ` · memo "${args.memo}"` : ""}`);
  if (!args.apply) {
    console.log("DRY-RUN: no se escribió nada. Usá --apply.");
    return;
  }
  const client = await pool.connect();
  try {
    const doc = await createBankTransfer(
      client,
      { day: args.day, from_account_list_id: args.from, to_account_list_id: args.to, amount_cents: args.cents, memo: args.memo },
      actor.id
    );
    console.log(`creado ${doc.doc_number} (${doc.id}, ${doc.status})`);
    const posted = await postBankTransfer(client, doc.id, actor.id);
    console.log(`posteado: ${posted.status} · asiento ${posted.entry_id} · QB: ${JSON.stringify(posted.qb)}`);
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("create-bank-transfer:", error instanceof Error ? error.message : error, (error as { details?: unknown })?.details ?? "");
    process.exit(1);
  });
