/**
 * verify-qb-deposit-readback — la contraparte de CADA escritura en QuickBooks
 * se verifica leyendo el documento de vuelta por TxnID y comparándolo con el
 * POS, nunca dando por hecho el encolado (deposit-surcharge-qb-20260915).
 *
 * Como script: compara N depósitos del POS (`bank_deposit`) con QuickBooks:
 *   env DATABASE_URL=… QB_BRIDGE_URL=… QB_API_KEY=… ./node_modules/.bin/tsx \
 *     src/scripts/verify/verify-qb-deposit-readback.ts --number DEP-0652 [--number …] | --from 2026-09-01 --to 2026-09-15
 *
 * Como módulo (`qbDirect`, `readDeposit`, `compareDeposit`, `readJournalEntry`,
 * `readCheck`): lo usan `merge-surcharge-deposits.ts` y
 * `convert-check-refund-to-card.ts` después de cada Mod/Del/Add/Void.
 *
 * Lee `DepositQueryRq` con líneas y afirma: mismo destino (`DepositToAccountRef`),
 * mismo total (= gross − fee del POS), cada línea de cobro del POS presente por
 * `PaymentTxnID` (cobro → ReceivePayment/SalesReceipt; refund → JournalEntry),
 * las líneas manuales por cuenta+monto, y la línea de surcharge (cuenta
 * `credit_card_surcharge`) por Σ surcharge de los snapshots. Sólo lectura.
 */
import { getDbPool } from "../../api/utils/db-pool";
import { bridgeFetch, pollRawOperationResult } from "../../lib/quickbooks/client/core";

const QBXML_HEAD = '<?xml version="1.0" encoding="utf-8"?><?qbxml version="11.0"?><QBXML><QBXMLMsgsRq onError="continueOnError">';
const QBXML_TAIL = "</QBXMLMsgsRq></QBXML>";

export type QbRs = Record<string, any>;

/** Passthrough crudo al bridge + poll. Devuelve el `QBXMLMsgsRs` (o lanza si la operación falló). */
export async function qbDirect(body: string, idempotencyKey?: string): Promise<QbRs> {
  const submitted = (await bridgeFetch("POST", "/api/sync/direct-query", { qbxml: `${QBXML_HEAD}${body}${QBXML_TAIL}` }, idempotencyKey ? { idempotencyKey } : undefined)) as
    | { operationId?: string; operation_id?: string }
    | undefined;
  const opId = submitted?.operationId ?? submitted?.operation_id;
  if (!opId) throw new Error("bridge did not return an operationId");
  const raw = (await pollRawOperationResult(opId, () => undefined)) as Record<string, unknown> | null;
  const status = (raw as { status?: string } | null)?.status;
  if (status && status !== "completed") throw new Error(`bridge op ${opId} ${status}: ${String((raw as { error?: unknown })?.error ?? "").slice(0, 300)}`);
  const result = (raw?.result ?? raw) as Record<string, unknown> | undefined;
  const qbxml = (result?.QBXML ?? result) as Record<string, unknown> | undefined;
  return (qbxml?.QBXMLMsgsRs ?? qbxml ?? {}) as QbRs;
}

const asList = <T,>(v: T | T[] | undefined | null): T[] => (Array.isArray(v) ? v : v ? [v] : []);
export const rsStatus = (rs: QbRs | undefined): { code: string; message: string } => ({
  code: String(rs?.$?.statusCode ?? rs?.statusCode ?? ""),
  message: String(rs?.$?.statusMessage ?? rs?.statusMessage ?? ""),
});
export const cents = (major: string | undefined): bigint => {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec((major ?? "0").trim());
  if (!m) throw new Error(`monto QB ilegible: ${major}`);
  const c = BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  return m[1] === "-" ? -c : c;
};

export type QbDepositLine = { TxnType?: string; TxnID?: string; TxnLineID?: string; AccountRef?: { ListID?: string; FullName?: string }; Amount?: string; Memo?: string; EntityRef?: { ListID?: string; FullName?: string } };
export type QbDeposit = { TxnID: string; EditSequence: string; TxnDate: string; DepositTotal: string; Memo?: string; DepositToAccountRef?: { ListID?: string; FullName?: string }; lines: QbDepositLine[] };

/** `DepositQueryRq` por TxnID; null si QB contesta "no existe" (statusCode 1 / 3120). */
export async function readDeposit(txnId: string): Promise<QbDeposit | null> {
  const rs = (await qbDirect(`<DepositQueryRq><TxnID>${txnId}</TxnID><IncludeLineItems>true</IncludeLineItems></DepositQueryRq>`)).DepositQueryRs;
  const st = rsStatus(rs);
  // QB contesta 500 "required element … could not be found" para un TxnID borrado (medido 09/15/2026).
  if (st.code === "1" || st.code === "3120" || (st.code === "500" && /could not be found/i.test(st.message))) return null;
  if (st.code !== "0") throw new Error(`DepositQuery ${txnId}: ${st.code} ${st.message}`);
  const ret = asList<any>(rs.DepositRet)[0];
  if (!ret) return null;
  return { TxnID: ret.TxnID, EditSequence: ret.EditSequence, TxnDate: ret.TxnDate, DepositTotal: ret.DepositTotal, Memo: ret.Memo, DepositToAccountRef: ret.DepositToAccountRef, lines: asList<QbDepositLine>(ret.DepositLineRet) };
}

export async function readJournalEntry(txnId: string): Promise<{ TxnID: string; TxnDate: string; debits: Array<{ account: string; amount: bigint; entity: string | null }>; credits: Array<{ account: string; amount: bigint }> } | null> {
  const rs = (await qbDirect(`<JournalEntryQueryRq><TxnID>${txnId}</TxnID><IncludeLineItems>true</IncludeLineItems></JournalEntryQueryRq>`)).JournalEntryQueryRs;
  const st = rsStatus(rs);
  if (st.code === "1" || st.code === "3120" || (st.code === "500" && /could not be found/i.test(st.message))) return null;
  if (st.code !== "0") throw new Error(`JournalEntryQuery ${txnId}: ${st.code} ${st.message}`);
  const ret = asList<any>(rs.JournalEntryRet)[0];
  if (!ret) return null;
  return {
    TxnID: ret.TxnID,
    TxnDate: ret.TxnDate,
    debits: asList<any>(ret.JournalDebitLine).map((l) => ({ account: l.AccountRef?.ListID ?? "", amount: cents(l.Amount), entity: l.EntityRef?.ListID ?? null })),
    credits: asList<any>(ret.JournalCreditLine).map((l) => ({ account: l.AccountRef?.ListID ?? "", amount: cents(l.Amount) })),
  };
}

export async function readCheck(txnId: string): Promise<{ TxnID: string; Amount: bigint; IsVoid: boolean; Memo?: string } | null> {
  const rs = (await qbDirect(`<CheckQueryRq><TxnID>${txnId}</TxnID></CheckQueryRq>`)).CheckQueryRs;
  const st = rsStatus(rs);
  if (st.code === "1" || st.code === "3120" || (st.code === "500" && /could not be found/i.test(st.message))) return null;
  if (st.code !== "0") throw new Error(`CheckQuery ${txnId}: ${st.code} ${st.message}`);
  const ret = asList<any>(rs.CheckRet)[0];
  if (!ret) return null;
  const amount = cents(ret.Amount);
  return { TxnID: ret.TxnID, Amount: amount, IsVoid: amount === 0n && /VOID/i.test(String(ret.Memo ?? "")), Memo: ret.Memo };
}

export type PosDepositView = {
  number: string | null;
  qb_txn_id: string | null;
  account_list_id: string | null;
  gross_cents: bigint;
  fee_cents: bigint;
  surcharge_cents: bigint;
  surcharge_account: string | null;
  payment_lines: Array<{ txn: string | null; cents: bigint; refund: boolean }>;
  manual_lines: Array<{ account: string; cents: bigint }>;
};

export async function loadPosDeposit(depositId: string): Promise<PosDepositView> {
  const pool = getDbPool();
  const h = (await pool.query(`SELECT d.number,d.qb_txn_id,COALESCE(d.account_list_id,(SELECT qb_list_id FROM bank_account WHERE id=d.account_id)) AS account_list_id,d.gross_amount,d.fee_amount FROM bank_deposit d WHERE d.id=$1`, [depositId])).rows[0];
  if (!h) throw new Error(`bank_deposit ${depositId} no existe`);
  const uf = (await pool.query(`SELECT qb_list_id FROM gl_account_map WHERE key='undeposited_funds'`)).rows[0]?.qb_list_id as string;
  const surchargeAccount = ((await pool.query(`SELECT qb_list_id FROM gl_account_map WHERE key='credit_card_surcharge'`)).rows[0]?.qb_list_id as string | undefined) ?? null;
  const lines = (await pool.query(
    `SELECT dl.payment_id, dl.amount, dl.manual_account_list_id, dl.payment_snapshot->>'surcharge_amount' AS surcharge,
            COALESCE(cp.qb->>'txn_id',cp.metadata->>'qb_txn_id') AS payment_txn,
            (SELECT je.qb_txn_id FROM gl_journal_entry je WHERE je.id=cp.qb->>'refund_journal_entry_id') AS refund_txn
       FROM bank_deposit_line dl LEFT JOIN customer_payment cp ON cp.id=dl.payment_id
      WHERE dl.deposit_id=$1 AND dl.deleted_at IS NULL ORDER BY dl.created_at, dl.id`, [depositId]
  )).rows as Array<{ payment_id: string | null; amount: string; manual_account_list_id: string | null; surcharge: string | null; payment_txn: string | null; refund_txn: string | null }>;
  let surcharge = 0n;
  const payment_lines: PosDepositView["payment_lines"] = [];
  const manual_lines: PosDepositView["manual_lines"] = [];
  for (const l of lines) {
    const c = cents(l.amount);
    if (l.payment_id) {
      const refund = c < 0n;
      payment_lines.push({ txn: refund ? l.refund_txn : l.payment_txn, cents: c, refund });
      if (!refund) surcharge += cents(l.surcharge ?? "0");
    } else manual_lines.push({ account: l.manual_account_list_id ?? uf, cents: c });
  }
  return { number: h.number, qb_txn_id: h.qb_txn_id, account_list_id: h.account_list_id, gross_cents: cents(h.gross_amount), fee_cents: cents(h.fee_amount), surcharge_cents: surcharge, surcharge_account: surchargeAccount, payment_lines, manual_lines };
}

/** Compara el POS con lo leído de QB. Devuelve la lista de diferencias (vacía = igual). */
export function compareDeposit(pos: PosDepositView, qb: QbDeposit | null, opts: { expectSurchargeLine: boolean }): string[] {
  const diffs: string[] = [];
  if (!qb) return [`QB no tiene el Deposit ${pos.qb_txn_id}`];
  if (qb.DepositToAccountRef?.ListID !== pos.account_list_id) diffs.push(`destino QB ${qb.DepositToAccountRef?.FullName} ≠ POS ${pos.account_list_id}`);
  const qbTotal = cents(qb.DepositTotal);
  const posNet = pos.gross_cents - pos.fee_cents;
  if (qbTotal !== posNet) diffs.push(`total QB ${qbTotal} ≠ POS neto ${posNet}`);
  const qbTxns = new Set(qb.lines.filter((l) => l.TxnID).map((l) => l.TxnID));
  for (const p of pos.payment_lines) {
    if (!p.txn) { diffs.push(`línea POS ${p.cents} sin TxnID`); continue; }
    if (!qbTxns.has(p.txn)) diffs.push(`QB no tiene la línea PaymentTxnID ${p.txn} (${p.cents})`);
  }
  const qbAccountLines = qb.lines.filter((l) => !l.TxnID).map((l) => ({ account: l.AccountRef?.ListID ?? "", cents: cents(l.Amount) }));
  for (const m of pos.manual_lines) {
    const i = qbAccountLines.findIndex((q) => q.account === m.account && q.cents === m.cents);
    if (i < 0) diffs.push(`QB no tiene la línea manual ${m.account} ${m.cents}`); else qbAccountLines.splice(i, 1);
  }
  if (opts.expectSurchargeLine && pos.surcharge_cents > 0n) {
    const i = qbAccountLines.findIndex((q) => q.account === pos.surcharge_account && q.cents === pos.surcharge_cents);
    if (i < 0) diffs.push(`QB no tiene la línea de surcharge ${pos.surcharge_account} ${pos.surcharge_cents}`); else qbAccountLines.splice(i, 1);
  }
  if (pos.fee_cents > 0n) {
    const i = qbAccountLines.findIndex((q) => q.cents === -pos.fee_cents);
    if (i < 0) diffs.push(`QB no tiene la línea de fee −${pos.fee_cents}`); else qbAccountLines.splice(i, 1);
  }
  for (const extra of qbAccountLines) diffs.push(`QB tiene una línea de más: ${extra.account} ${extra.cents}`);
  const posLineCount = pos.payment_lines.length + pos.manual_lines.length + (opts.expectSurchargeLine && pos.surcharge_cents > 0n ? 1 : 0) + (pos.fee_cents > 0n ? 1 : 0);
  if (qb.lines.length !== posLineCount) diffs.push(`QB tiene ${qb.lines.length} líneas, POS espera ${posLineCount}`);
  return diffs;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const numbers = argv.flatMap((a, i) => (a === "--number" && argv[i + 1] ? [argv[i + 1]!] : []));
  const one = (f: string): string | null => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]!] : []))[0] ?? null;
  const pool = getDbPool();
  const rows = (await pool.query<{ id: string; number: string; qb_txn_id: string | null }>(
    numbers.length
      ? `SELECT id, number, qb_txn_id FROM bank_deposit WHERE number = ANY($1::text[]) AND deleted_at IS NULL ORDER BY number`
      : `SELECT id, number, qb_txn_id FROM bank_deposit WHERE deposit_date BETWEEN $1 AND $2 AND deleted_at IS NULL AND status<>'void' ORDER BY deposit_date, number`,
    numbers.length ? [numbers] : [one("--from") ?? "2026-09-01", one("--to") ?? "2026-09-30"]
  )).rows;
  let bad = 0;
  for (const r of rows) {
    if (!r.qb_txn_id) { console.log(`· ${r.number}: sin TxnID en QB`); continue; }
    const pos = await loadPosDeposit(r.id);
    const qb = await readDeposit(r.qb_txn_id);
    const diffs = compareDeposit(pos, qb, { expectSurchargeLine: argv.includes("--expect-surcharge") });
    console.log(`${diffs.length ? "❌" : "✅"} ${r.number} ${r.qb_txn_id}${diffs.length ? " — " + diffs.join(" · ") : ""}`);
    if (diffs.length) bad++;
  }
  await pool.end();
  console.log(`\n${rows.length - bad}/${rows.length} depósitos iguales en QB`);
  process.exit(bad ? 1 : 0);
}
if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
