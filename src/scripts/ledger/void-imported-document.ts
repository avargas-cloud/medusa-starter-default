/**
 * void-imported-document — reversa en el libro del POS UN documento importado de QuickBooks
 * (`qb_import:<TxnID>`) que se anuló (o se va a anular) en QB con TxnVoid. El importador no
 * vuelve a traerlo (un TxnVoid lo deja en $0 en el reporte) y no hay pipeline para un doc
 * que el POS nunca emitió: el TxnVoid va por el bridge (`/qb-query` raw) y esta reversa es
 * el espejo. Append-only: el asiento original queda y se le cuelga una reversa.
 *
 * Caso que lo motivó (Amex 5009, 2026-09-15, contador P13): dos Credit Card Charges de 2025
 * que QB tiene con el año mal tipeado en 2026 (LSL 10,70 · Sunoco 45,01). Ya están dentro de la
 * partida de apertura + JE-0003 del 01/01, así que en 2026 son gasto duplicado.
 *
 * `--day` es el día de la reversa: el ORIGINAL puede vivir en un extracto cerrado (LSL en enero) y
 * el guard `bank_statement_journal_guard` rechaza toda línea de la tarjeta fechada ahí → se fecha
 * en el primer período abierto. Un extracto cerrado no cambia (su libro termina en su `to`).
 *
 *   … ./node_modules/.bin/tsx src/scripts/ledger/void-imported-document.ts \
 *       --txn 1C527B-1779565679 --day 2026-04-01 --reason "…" [--apply]
 *
 * DRY-RUN por default. Se puede pasar `--txn` varias veces (todos al mismo `--day`).
 */
import { getDbPool } from "../../api/utils/db-pool";
import { activeDocumentEntry, reverseDocumentJournal } from "../../lib/ledger/post";

function parseArgs(argv: string[]): { txns: string[]; day: string; reason: string; actor: string; apply: boolean } {
  const values = (flag: string): string[] => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const day = values("--day")[0], reason = values("--reason")[0], txns = values("--txn");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day YYYY-MM-DD es obligatorio");
  if (!reason) throw new Error("--reason es obligatorio (queda en el asiento de reversa)");
  if (!txns.length) throw new Error("falta --txn <TxnID de QB>");
  return { txns, day, reason, actor: values("--actor")[0] ?? "a.vargas@ecopowertech.com", apply: argv.includes("--apply") };
}

const money = (c: string): string => (Number(c) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [args.actor])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${args.actor}`);
  const client = await pool.connect();
  try {
    for (const txn of args.txns) {
      const active = await activeDocumentEntry(client, "qb_import", txn);
      console.log(`\nqb_import:${txn}`);
      if (!active) {
        console.log("  sin asiento activo (no importado, o ya reversado): nada que hacer");
        continue;
      }
      const lines = (
        await client.query<{ role: string; name: string; debit_cents: string; credit_cents: string; reference: string }>(
          `SELECT l.role,l.account_snapshot->>'name' AS name,l.debit_cents::text,l.credit_cents::text,e.reference
             FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id WHERE l.entry_id=$1 ORDER BY l.role`,
          [active.id]
        )
      ).rows;
      console.log(`  asiento ${active.id} · día ${active.day} · ${lines[0]?.reference ?? ""} · ${lines.length} líneas`);
      for (const l of lines) console.log(`    ${l.role}  ${l.name.padEnd(45)} D ${money(l.debit_cents).padStart(10)}  C ${money(l.credit_cents).padStart(10)}`);
      console.log(`  → reversa fechada ${args.day} (${args.reason})`);
      if (!args.apply) continue;
      const rev = await reverseDocumentJournal(client, { source_kind: "qb_import", source_id: txn, day: args.day, reason: args.reason, actor_id: actor.id });
      console.log(`  reversa: ${rev.status}${"entry_id" in rev ? ` ${rev.entry_id}` : ""}`);
    }
    if (!args.apply) console.log("\nDRY-RUN: no se escribió nada. Usá --apply.");
  } finally {
    client.release();
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => { console.error("void-imported-document:", e instanceof Error ? e.message : e); process.exit(1); });
