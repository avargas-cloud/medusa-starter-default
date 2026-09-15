/**
 * convert-check-refund-to-card — un refund de TARJETA que el POS mandó a
 * QuickBooks como Write Check pasa al formato nuevo (deposit-surcharge-qb-20260915):
 *
 *  1. POS: se anula el `gl_check` adoptado (CHK-####) → lane `gl_document_void`
 *     → TxnVoid del Check en QB → se espera la confirmación de la fila del
 *     pipeline (nunca al encolar) → readback `CheckQuery`: monto 0.00 / VOID.
 *  2. POS: `recordCardRefundJournal` → JE-#### Dr AR (cliente) / Cr UF por el
 *     principal → lane JournalEntryAdd → confirmación → readback
 *     `JournalEntryQuery`: cuentas, monto y entidad.
 *  3. El cobro queda `refund_settlement='processor_batch'`; Record Deposits lo
 *     ofrece como línea NEGATIVA para el lote donde BAMS lo netea.
 *
 * Dry-run por default. `--wait-seconds 0` no espera al pipeline (sandbox sin crons).
 *
 *   env DATABASE_URL=… QB_BRIDGE_URL=… QB_API_KEY=… DISABLE_SCHEDULED_JOBS=true ./node_modules/.bin/tsx \
 *     src/scripts/ledger/convert-check-refund-to-card.ts --payment 3806 [--payment 4994] --day 2026-09-15 [--apply] [--wait-seconds 360]
 */
import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";
import { voidBankCheck } from "../../lib/ledger/documents/bank-check";
import { recordCardRefundJournal } from "../../lib/ledger/documents/card-refund";
import { readCheck, readJournalEntry } from "../verify/verify-qb-deposit-readback";

const ACTOR = "convert-check-refund-to-card";

type Target = { payment_id: string; display_id: number; customer_name: string; refund_cents: string; check_txn_id: string | null; gl_check_id: string | null; check_number: string | null; check_status: string | null; settlement: string | null };

async function loadTargets(client: PoolClient, displayIds: number[]): Promise<Target[]> {
  return (await client.query<Target>(
    `SELECT mp.id AS payment_id, mp.display_id, COALESCE(NULLIF(c.company_name,''),trim(concat_ws(' ',c.first_name,c.last_name))) AS customer_name,
            COALESCE(mp.metadata->>'refund_amount', mp.amount::text) AS refund_cents, mp.qb->>'check_txn_id' AS check_txn_id,
            gc.id AS gl_check_id, gc.doc_number AS check_number, gc.status AS check_status, mp.qb->>'refund_settlement' AS settlement
       FROM customer_payment mp JOIN customer c ON c.id=mp.customer_id
       LEFT JOIN gl_check gc ON gc.qb_txn_id = mp.qb->>'check_txn_id'
      WHERE mp.display_id = ANY($1::int[]) AND mp.deleted_at IS NULL AND mp.status IN ('refunded','partial_refunded') ORDER BY mp.display_id`, [displayIds]
  )).rows;
}

async function waitConfirmed(client: PoolClient, referenceId: string, step: string, seconds: number): Promise<{ status: string; qb_txn_id: string | null } | null> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const row = (await client.query<{ status: string; qb_txn_id: string | null; error: string | null }>(
      `SELECT status, qb_txn_id, error FROM qb_order_pipeline WHERE reference_id=$1 AND step=$2 ORDER BY created_at DESC LIMIT 1`, [referenceId, step]
    )).rows[0];
    if (!row) return null;
    if (["confirmed", "skipped"].includes(row.status)) return row;
    if (row.status === "failed") throw new Error(`${step} ${referenceId} failed: ${row.error}`);
    if (Date.now() > deadline) return row;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const ids = argv.flatMap((a, i) => (a === "--payment" && argv[i + 1] ? [Number(argv[i + 1])] : []));
  const one = (f: string): string | null => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]!] : []))[0] ?? null;
  const day = one("--day"); const apply = argv.includes("--apply"); const wait = Number(one("--wait-seconds") ?? 360);
  if (!ids.length || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("usage: --payment <display_id>… --day YYYY-MM-DD [--apply] [--wait-seconds N]");
  const client = await getDbPool().connect();
  try {
    const targets = await loadTargets(client, ids);
    for (const t of targets) console.log(`#${t.display_id} ${t.customer_name} refund ${Number(t.refund_cents) / 100} · check ${t.check_number ?? "—"} (${t.check_status ?? "—"}, QB ${t.check_txn_id ?? "—"}) · settlement ${t.settlement ?? "check"}`);
    if (!apply) { console.log("\n(dry-run: nada escrito; --apply para convertir con readback de cada escritura en QB)"); return; }
    for (const t of targets) {
      console.log(`\n══ #${t.display_id} ══`);
      // 1. void del cheque (POS → TxnVoid Check)
      if (t.gl_check_id && t.check_status === "posted") {
        await voidBankCheck(client, t.gl_check_id, `Refund de tarjeta neteado por el procesador — reemplazado por JE (deposit-surcharge-qb-20260915)`, ACTOR);
        const row = await waitConfirmed(client, t.gl_check_id, "gl_document_void", wait);
        console.log(`  ${t.check_number} anulado en el POS; pipeline gl_document_void: ${row?.status ?? "sin fila"}`);
        if (wait > 0 && t.check_txn_id) {
          const chk = await readCheck(t.check_txn_id);
          if (!chk || !chk.IsVoid) throw new Error(`#${t.display_id}: readback del cheque ${t.check_txn_id} no está VOID (${JSON.stringify(chk)}) — DETENIDO`);
          console.log(`  QB readback: Check ${t.check_txn_id} VOID ✓`);
        }
      } else console.log(`  cheque ya anulado/ausente (${t.check_status ?? "—"})`);
      // 2. el cobro deja de ser "cheque" y nace el JE
      await client.query(`UPDATE customer_payment SET qb = (COALESCE(qb,'{}'::jsonb) - 'check_txn_id' - 'status') || $2::jsonb, updated_at=now() WHERE id=$1`,
        [t.payment_id, JSON.stringify({ legacy_check_txn_id: t.check_txn_id, legacy_check_voided_by: ACTOR })]);
      const je = await recordCardRefundJournal(client, t.payment_id, day, ACTOR);
      const row = await waitConfirmed(client, je.journal_entry_id, "gl_document_add", wait);
      console.log(`  ${je.number} posteado; pipeline gl_document_add: ${row?.status ?? "sin fila"} ${row?.qb_txn_id ?? ""}`);
      if (wait > 0) {
        if (!row?.qb_txn_id) throw new Error(`#${t.display_id}: el JE no confirmó en QB — DETENIDO`);
        const qbje = await readJournalEntry(row.qb_txn_id);
        const ar = (await client.query<{ q: string }>(`SELECT qb_list_id AS q FROM gl_account_map WHERE key='accounts_receivable'`)).rows[0]!.q;
        const uf = (await client.query<{ q: string }>(`SELECT qb_list_id AS q FROM gl_account_map WHERE key='undeposited_funds'`)).rows[0]!.q;
        const cents = BigInt(t.refund_cents.split(".")[0]!);
        const ok = !!qbje && qbje.debits.some((d) => d.account === ar && d.amount === cents && !!d.entity) && qbje.credits.some((c) => c.account === uf && c.amount === cents);
        if (!ok) throw new Error(`#${t.display_id}: readback del JE ${row.qb_txn_id} no coincide: ${JSON.stringify(qbje)} — DETENIDO`);
        console.log(`  QB readback: JE ${row.qb_txn_id} Dr AR(cliente) ${Number(cents) / 100} / Cr UF ✓`);
      }
    }
    console.log(`\nconvertidos ${targets.length}: aparecen como líneas negativas en Record Deposits (lote del día siguiente).`);
  } finally {
    client.release();
    await getDbPool().end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
