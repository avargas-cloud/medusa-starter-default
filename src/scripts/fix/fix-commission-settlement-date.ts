/**
 * Re-fecha los documentos de una liquidación de comisión por STORE CREDIT ya
 * emitida: el Check (clearing → vendor) y el ReceivePayment (customer) en
 * QuickBooks, y el crédito POS (`customer_payment.received_at` / `batch_day`).
 *
 * Caso que lo originó (2026-09-10): el settle fechaba "hoy" fijo; AAF
 * (COM-1003, bill original del 2026-08-14) se re-liquidó como store credit y
 * sus documentos cayeron en 09-10 — el gasto salió del período del contador.
 * Desde ese día el SettleModal pide la fecha; este script arregla lo emitido.
 *
 * Los dos documentos de QB reciben la MISMA fecha (la clearing tiene que dar
 * $0 en cualquier corte). Cada Mod manda SÓLO TxnDate — sin AppliedToTxnMod,
 * así que no toca aplicaciones (el payment de comisión nace sin aplicar).
 *
 * Read-only por default: relee QB y muestra el plan. APPLY=true escribe,
 * pollea cada Mod y RELEE los dos documentos para verificar fecha nueva y
 * monto/cuenta/unused intactos. Idempotente por campo: un doc ya fechado se
 * saltea.
 *
 *   cd backend && env DATABASE_URL=… QB_BRIDGE_URL=… QB_API_KEY=… \
 *     SETTLEMENT_ID=cset_… DATE=2026-08-14 [APPLY=true] \
 *     ./node_modules/.bin/tsx src/scripts/fix/fix-commission-settlement-date.ts
 */

import { Pool } from "pg";
import { bridgeFetch, pollBridgeStatus } from "../../lib/quickbooks/bridge-fetch";
import { pollOperationResult } from "../../lib/quickbooks/client/core";
import { updateCheckInQb } from "../../lib/quickbooks/client/checks";
import { updatePaymentTxnDateInQb } from "../../lib/quickbooks/client/payments";

const SETTLEMENT_ID = process.env.SETTLEMENT_ID ?? "";
const DATE = process.env.DATE ?? "";
const APPLY = process.env.APPLY === "true";

interface DocSnapshot {
  txnDate: string;
  amount: string;
  account: string;
  extra: string;
  editSequence: string;
}

async function query(qbxmlBody: string): Promise<Record<string, any>> {
  const qbxml =
    '<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>' +
    `<QBXML><QBXMLMsgsRq onError="stopOnError">${qbxmlBody}</QBXMLMsgsRq></QBXML>`;
  const enqueued = await bridgeFetch<{ operationId?: string }>("/api/sync/direct-query", {
    method: "POST",
    body: { qbxml },
    timeoutMs: 30_000,
  });
  if (!enqueued?.operationId) throw new Error("direct-query sin operationId");
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4_000));
    const polled = await pollBridgeStatus(enqueued.operationId);
    if (polled.status === "expired") throw new Error("query expiró en el bridge");
    const op = (polled.data as Record<string, any>)?.operation;
    if (op?.status === "failed") throw new Error(`query falló: ${String(op.error)}`);
    if (op?.status === "completed") return op.result?.QBXML?.QBXMLMsgsRs ?? {};
  }
  throw new Error("timeout en la query");
}

async function readCheck(txnId: string): Promise<DocSnapshot> {
  const rs = await query(`<CheckQueryRq><TxnID>${txnId}</TxnID><IncludeLineItems>true</IncludeLineItems></CheckQueryRq>`);
  const ret = rs.CheckQueryRs?.CheckRet;
  if (!ret) throw new Error(`Check ${txnId} no encontrado`);
  return {
    txnDate: String(ret.TxnDate),
    amount: String(ret.Amount),
    account: String(ret.AccountRef?.FullName),
    extra: `payee=${ret.PayeeEntityRef?.FullName} expense=${ret.ExpenseLineRet?.AccountRef?.FullName} toPrint=${ret.IsToBePrinted}`,
    editSequence: String(ret.EditSequence),
  };
}

async function readPayment(txnId: string): Promise<DocSnapshot> {
  const rs = await query(`<ReceivePaymentQueryRq><TxnID>${txnId}</TxnID><IncludeLineItems>true</IncludeLineItems></ReceivePaymentQueryRq>`);
  const ret = rs.ReceivePaymentQueryRs?.ReceivePaymentRet;
  if (!ret) throw new Error(`ReceivePayment ${txnId} no encontrado`);
  return {
    txnDate: String(ret.TxnDate),
    amount: String(ret.TotalAmount),
    account: String(ret.DepositToAccountRef?.FullName),
    extra: `customer=${ret.CustomerRef?.FullName} method=${ret.PaymentMethodRef?.FullName} unused=${ret.UnusedPayment}`,
    editSequence: String(ret.EditSequence),
  };
}

function assertUnchanged(label: string, before: DocSnapshot, after: DocSnapshot, date: string): void {
  if (after.txnDate !== date) throw new Error(`${label}: TxnDate quedó ${after.txnDate}, esperaba ${date}`);
  if (after.amount !== before.amount || after.account !== before.account || after.extra !== before.extra) {
    throw new Error(`${label}: algo más que la fecha cambió — antes ${JSON.stringify(before)} / después ${JSON.stringify(after)}`);
  }
}

async function main(): Promise<void> {
  if (!SETTLEMENT_ID.startsWith("cset_")) throw new Error("SETTLEMENT_ID requerido (cset_…)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) throw new Error("DATE requerida (YYYY-MM-DD)");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL requerida");
  const pool = new Pool({ connectionString: dbUrl });

  const { rows } = await pool.query<{
    method: string; status: string; check: string | null; payment: string | null; cpay: string | null;
    cpay_batch_day: string | null; cpay_received_at: Date | null; display_name: string;
  }>(
    `SELECT s.method, s.status, s.qb_check_txn_id AS check, s.qb_payment_txn_id AS payment,
            s.customer_payment_id AS cpay, cp.batch_day AS cpay_batch_day, cp.received_at AS cpay_received_at,
            r.display_name
       FROM commission_settlement s
       JOIN order_commission_recipient r ON r.id = s.recipient_id
       LEFT JOIN customer_payment cp ON cp.id = s.customer_payment_id
      WHERE s.id = $1`,
    [SETTLEMENT_ID]
  );
  const s = rows[0];
  if (!s) throw new Error("settlement no encontrado");
  if (s.method !== "store_credit" || s.status !== "confirmed") {
    throw new Error(`sólo store_credit confirmado; este es ${s.method}/${s.status}`);
  }
  if (!s.check || !s.payment || !s.cpay) throw new Error("settlement sin TxnIDs/cpay confirmados");
  console.log(`Settlement ${SETTLEMENT_ID} · ${s.display_name} · check=${s.check} payment=${s.payment} cpay=${s.cpay} (batch_day ${s.cpay_batch_day})`);

  const checkBefore = await readCheck(s.check);
  const payBefore = await readPayment(s.payment);
  console.log("QB antes — check:", checkBefore);
  console.log("QB antes — payment:", payBefore);
  if (checkBefore.amount !== payBefore.amount) throw new Error("check y payment no coinciden en monto — revisar a mano");

  const todo = {
    check: checkBefore.txnDate !== DATE,
    payment: payBefore.txnDate !== DATE,
    cpay: s.cpay_batch_day !== DATE,
  };
  console.log(`PLAN → ${DATE}:`, todo);
  if (!todo.check && !todo.payment && !todo.cpay) {
    console.log("✅ ya está todo en esa fecha.");
    await pool.end();
    return;
  }
  if (!APPLY) {
    console.log("DRY RUN — sin escribir. APPLY=true para aplicar.");
    await pool.end();
    return;
  }

  if (todo.check) {
    const r = await updateCheckInQb(s.check, { date: DATE }, (m) => console.log(m));
    if (!r.success || !r.data?.operationId) throw new Error(`CheckMod no encolado: ${r.success ? "sin opId" : r.error}`);
    await pollOperationResult(r.data.operationId, (m) => console.log(m));
  }
  if (todo.payment) {
    const r = await updatePaymentTxnDateInQb(s.payment, DATE, (m) => console.log(m));
    if (!r.success || !r.data?.operationId) throw new Error(`ReceivePaymentMod no encolado: ${r.success ? "sin opId" : r.error}`);
    await pollOperationResult(r.data.operationId, (m) => console.log(m));
  }
  if (todo.cpay) {
    const res = await pool.query(
      `UPDATE customer_payment
          SET received_at = ($2 || 'T12:00:00-04:00')::timestamptz, batch_day = $2, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [s.cpay, DATE]
    );
    console.log(`cpay ${s.cpay}: ${res.rowCount} fila → received_at/batch_day ${DATE}`);
  }

  const checkAfter = await readCheck(s.check);
  const payAfter = await readPayment(s.payment);
  assertUnchanged("check", checkBefore, checkAfter, DATE);
  assertUnchanged("payment", payBefore, payAfter, DATE);
  console.log(`✅ ${s.display_name}: check ${checkBefore.txnDate}→${checkAfter.txnDate} · payment ${payBefore.txnDate}→${payAfter.txnDate} · cpay ${DATE}; montos/cuentas/unused intactos.`);
  await pool.end();
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
