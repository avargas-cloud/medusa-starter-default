/**
 * void-gl-document — anula UN documento manual del GL (`gl_check` / `gl_transfer` / `gl_journal_entry`)
 * desde la terminal: draft → voided (sin asiento) o posted → reversa + voided (+ TxnVoid en QB por el
 * pipeline). Misma función que el botón Void de la pantalla.
 *
 *   … ./node_modules/.bin/tsx src/scripts/ledger/void-gl-document.ts --kind check|transfer|journal --id <gchk_…> --reason "…" [--apply]
 */
import { getDbPool } from "../../api/utils/db-pool";
import { voidBankCheck, voidBankTransfer, voidJournalEntry } from "../../lib/ledger";

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
async function main(): Promise<void> {
  const kind = arg("--kind"), id = arg("--id"), reason = arg("--reason"), actorEmail = arg("--actor") ?? "a.vargas@ecopowertech.com";
  if (!kind || !id || !reason) throw new Error("usage: --kind check|transfer|journal --id <id> --reason … [--apply]");
  const table = kind === "check" ? "gl_check" : kind === "transfer" ? "gl_transfer" : kind === "journal" ? "gl_journal_entry" : null;
  if (!table) throw new Error(`--kind inválido: ${kind}`);
  const pool = getDbPool();
  const actor = (await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE lower(email)=lower($1) AND deleted_at IS NULL`, [actorEmail])).rows[0];
  if (!actor) throw new Error(`actor no encontrado: ${actorEmail}`);
  const row = (await pool.query<{ doc_number: string | null; status: string; day: string; entry_id: string | null }>(`SELECT doc_number,status,day::text AS day,entry_id FROM ${table} WHERE id=$1 AND deleted_at IS NULL`, [id])).rows[0];
  if (!row) throw new Error(`${table} ${id}: no existe`);
  console.log(`${table} ${row.doc_number ?? id} · ${row.day} · ${row.status}${row.entry_id ? ` · asiento ${row.entry_id}` : " · sin asiento"} → voided (${reason})`);
  if (!process.argv.includes("--apply")) {
    console.log("DRY-RUN: no se escribió nada. Usá --apply.");
    return;
  }
  const client = await pool.connect();
  try {
    const fn = kind === "check" ? voidBankCheck : kind === "transfer" ? voidBankTransfer : voidJournalEntry;
    const r = await fn(client, id, reason, actor.id);
    console.log(`anulado: ${JSON.stringify(r)}`);
  } finally {
    client.release();
  }
}
main().then(() => process.exit(0)).catch((e: unknown) => { console.error("void-gl-document:", e instanceof Error ? e.message : e); process.exit(1); });
