/**
 * create-journal-entry — crea y postea UN asiento manual del POS (`gl_journal_entry`) desde la
 * terminal: libro + encolado a QuickBooks (JournalEntryAdd por el pipeline, desde `842eb0c8`).
 * Misma función que Accounting → Journal Entries.
 *
 * Caso que lo motivó (Wells 1221, 2026-09-14, contador P5): un cheque "Cash" de $90 a un cliente
 * fechado 31/12/2025 que nunca se pagó — se anula con Dr Wells / Cr Accounts Receivable (cliente).
 *
 *   ECOPOWERTECH_ENV=… DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/ledger/create-journal-entry.ts \
 *     --day 2025-12-31 --memo "…" \
 *     --debit  "<account_list_id>:<dólares>[:memo][:customer=<id>|vendor=<id>]" \
 *     --credit "<account_list_id>:<dólares>[:memo][:customer=<id>|vendor=<id>]" [--apply]
 *
 * DRY-RUN por default. `--apply` crea el draft, lo postea y muestra el encolado a QB.
 */
import { getDbPool } from "../../api/utils/db-pool";
import { createJournalEntry, postJournalEntry } from "../../lib/ledger";
import type { JournalEntryLineInput } from "../../lib/ledger/documents/journal-entry-read";

type RawLine = { account: string; cents: bigint; memo: string | null; entity_type: "customer" | "vendor" | null; entity_id: string | null };

function parseLine(raw: string): RawLine {
  const parts = raw.split(":");
  const account = parts[0],
    dollars = parts[1];
  if (!account || !dollars || !/^\d+(\.\d{1,2})?$/.test(dollars)) throw new Error(`línea espera acct:dólares[:memo][:customer=id], recibió ${raw}`);
  let memo: string | null = null,
    entity_type: RawLine["entity_type"] = null,
    entity_id: string | null = null;
  for (const p of parts.slice(2)) {
    const m = /^(customer|vendor)=(.+)$/.exec(p);
    if (m) {
      entity_type = m[1] as "customer" | "vendor";
      entity_id = m[2]!;
    } else memo = memo ? `${memo}:${p}` : p;
  }
  return { account, cents: BigInt(Math.round(Number(dollars) * 100)), memo, entity_type, entity_id };
}

function parseArgs(argv: string[]) {
  const values = (flag: string): string[] => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const day = values("--day")[0];
  if (!day) throw new Error("--day YYYY-MM-DD es obligatorio");
  const debits = values("--debit").map(parseLine),
    credits = values("--credit").map(parseLine);
  if (!debits.length || !credits.length) throw new Error("falta --debit y/o --credit");
  return { day, memo: values("--memo")[0] ?? null, actor: values("--actor")[0] ?? "a.vargas@ecopowertech.com", apply: argv.includes("--apply"), debits, credits };
}

const money = (c: bigint): string => (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [args.actor])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${args.actor}`);
  const all = [...args.debits, ...args.credits];
  const accounts = new Map(
    (await pool.query<{ qb_list_id: string; name: string }>(`SELECT qb_list_id,name FROM qb_account WHERE qb_list_id = ANY($1::text[])`, [all.map((l) => l.account)])).rows.map((r) => [r.qb_list_id, r.name])
  );
  const lines: JournalEntryLineInput[] = [];
  console.log(`Journal Entry · ${args.day}${args.memo ? ` · memo "${args.memo}"` : ""}`);
  for (const [side, list] of [["Dr", args.debits], ["Cr", args.credits]] as const) {
    for (const l of list) {
      const name = accounts.get(l.account);
      if (!name) throw new Error(`cuenta ${l.account} no existe en qb_account`);
      let entity_name: string | null = null;
      if (l.entity_type === "customer") {
        const c = (await pool.query<{ qb: string | null; name: string }>(`SELECT metadata->>'qb_list_id' AS qb, coalesce(nullif(company_name,''), first_name||' '||last_name) AS name FROM customer WHERE id=$1 AND deleted_at IS NULL`, [l.entity_id ?? ""])).rows[0];
        if (!c?.qb) throw new Error(`customer ${l.entity_id}: no encontrado o sin qb_list_id`);
        entity_name = c.name;
      } else if (l.entity_type === "vendor") {
        const v = (await pool.query<{ qb_list_id: string; full_name: string }>(`SELECT qb_list_id, full_name FROM qb_vendor WHERE id=$1 AND deleted_at IS NULL`, [l.entity_id ?? ""])).rows[0];
        if (!v || v.qb_list_id.startsWith("pending_")) throw new Error(`vendor ${l.entity_id}: no encontrado o sin ListID`);
        entity_name = v.full_name;
      }
      console.log(`  ${side} ${name.padEnd(36)} ${money(l.cents).padStart(12)}  ${l.memo ?? ""}${entity_name ? `  [${l.entity_type}: ${entity_name}]` : ""}`);
      lines.push({
        account_list_id: l.account,
        debit_cents: side === "Dr" ? l.cents : 0n,
        credit_cents: side === "Cr" ? l.cents : 0n,
        memo: l.memo,
        entity_type: l.entity_type,
        entity_id: l.entity_id,
        entity_name,
      });
    }
  }
  const dr = args.debits.reduce((s, l) => s + l.cents, 0n),
    cr = args.credits.reduce((s, l) => s + l.cents, 0n);
  if (dr !== cr) throw new Error(`no balancea: Dr ${money(dr)} ≠ Cr ${money(cr)}`);
  if (!args.apply) {
    console.log("DRY-RUN: no se escribió nada. Usá --apply.");
    return;
  }
  const client = await pool.connect();
  try {
    const doc = await createJournalEntry(client, { day: args.day, memo: args.memo, lines }, actor.id);
    console.log(`creado ${doc.doc_number} (${doc.id}, ${doc.status})`);
    const posted = await postJournalEntry(client, doc.id, actor.id);
    console.log(`posteado: ${posted.status} · asiento ${posted.entry_id} · QB: ${JSON.stringify(posted.qb)}`);
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("create-journal-entry:", error instanceof Error ? error.message : error, (error as { details?: unknown })?.details ?? "");
    process.exit(1);
  });
