/**
 * Corrige el PaymentMethodRef del ReceivePayment de una comisión store_credit
 * que salió como "Cash" (2026-09-10, COM-1004 / 1D0099-1789064090).
 *
 * Por qué: el handler `handle-commission-settlement.ts` hardcodeaba "Cash", y el
 * cierre del día del contador agrupa pagos por método → $82.41 de efectivo que
 * nunca entró. El documento en sí es correcto (DepositTo = clearing, sin
 * aplicar); sólo se cambia la ETIQUETA con un ReceivePaymentMod que manda
 * únicamente PaymentMethodRef (mismo helper que el cambio de método del POS).
 *
 * Read-only por default: lee el payment en QB, verifica que sea el de la
 * comisión y muestra qué haría. Con APPLY=true emite el Mod, pollea el
 * resultado y RELEE QB para confirmar método nuevo + monto/deposit intactos.
 *
 *   cd backend && env DATABASE_URL=... QB_BRIDGE_URL=... QB_API_KEY=... \
 *     ./node_modules/.bin/tsx src/scripts/fix/fix-commission-payment-method-1D0099.ts
 *   ... APPLY=true ./node_modules/.bin/tsx src/scripts/fix/fix-commission-payment-method-1D0099.ts
 */

import { Pool } from "pg";
import { bridgeFetch, pollBridgeStatus } from "../../lib/quickbooks/bridge-fetch";
import { pollOperationResult } from "../../lib/quickbooks/client/core";
import { updatePaymentMethodInQb } from "../../lib/quickbooks/client/payments";
import { COMMISSION_CREDIT_QB_PAYMENT_METHOD } from "../../lib/quickbooks/handlers/handle-commission-settlement";

const TXN_ID = process.env.TXN_ID ?? "1D0099-1789064090";
const CLEARING_FULL_NAME = "Referral Commission Clearing";
const APPLY = process.env.APPLY === "true";

interface PaymentSnapshot {
  editSequence: string;
  method: string | null;
  depositTo: string | null;
  total: string;
  unused: string;
  memo: string;
  customerListId: string;
}

async function readPayment(): Promise<PaymentSnapshot> {
  const qbxml =
    '<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>' +
    '<QBXML><QBXMLMsgsRq onError="stopOnError"><ReceivePaymentQueryRq>' +
    `<TxnID>${TXN_ID}</TxnID><IncludeLineItems>true</IncludeLineItems>` +
    "</ReceivePaymentQueryRq></QBXMLMsgsRq></QBXML>";
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
    if (op?.status === "completed") {
      const rs = op.result?.QBXML?.QBXMLMsgsRs?.ReceivePaymentQueryRs;
      const ret = rs?.ReceivePaymentRet;
      if (!ret) throw new Error(`sin ReceivePaymentRet: ${JSON.stringify(rs?.$ ?? rs).slice(0, 200)}`);
      return {
        editSequence: String(ret.EditSequence),
        method: ret.PaymentMethodRef?.FullName ?? null,
        depositTo: ret.DepositToAccountRef?.FullName ?? null,
        total: String(ret.TotalAmount),
        unused: String(ret.UnusedPayment ?? "0"),
        memo: String(ret.Memo ?? ""),
        customerListId: String(ret.CustomerRef?.ListID ?? ""),
      };
    }
  }
  throw new Error("timeout leyendo el payment");
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL requerida");
  const pool = new Pool({ connectionString: dbUrl });

  // Identidad local: el cpay de comisión que apunta a este TxnID.
  const { rows } = await pool.query<{ id: string; amount: number; method: string; settlement: string }>(
    `SELECT id, amount, method, metadata->>'commission_settlement_id' AS settlement
       FROM customer_payment
      WHERE metadata->>'qb_txn_id' = $1
        AND metadata->>'is_commission_credit' = 'true'
        AND deleted_at IS NULL`,
    [TXN_ID]
  );
  await pool.end();
  if (rows.length !== 1) {
    throw new Error(`esperaba 1 customer_payment de comisión con qb_txn_id=${TXN_ID}, hay ${rows.length}`);
  }
  const cpay = rows[0];
  console.log(`POS: ${cpay.id} method=${cpay.method} amount=${cpay.amount} settlement=${cpay.settlement}`);

  const before = await readPayment();
  console.log("QB antes:", before);

  const expectedTotal = (Number(cpay.amount) / 100).toFixed(2);
  if (before.depositTo !== CLEARING_FULL_NAME) throw new Error(`DepositTo no es la clearing: ${before.depositTo}`);
  if (!before.memo.startsWith("Commission")) throw new Error(`memo no es de comisión: ${before.memo}`);
  if (Number(before.total).toFixed(2) !== expectedTotal) throw new Error(`monto QB ${before.total} ≠ POS ${expectedTotal}`);
  if (before.method === COMMISSION_CREDIT_QB_PAYMENT_METHOD) {
    console.log(`✅ ya está en "${COMMISSION_CREDIT_QB_PAYMENT_METHOD}" — nada que hacer.`);
    return;
  }

  console.log(`PLAN: ReceivePaymentMod ${TXN_ID} PaymentMethodRef "${before.method}" → "${COMMISSION_CREDIT_QB_PAYMENT_METHOD}" (sólo ese campo; EditSequence ${before.editSequence})`);
  if (!APPLY) {
    console.log("DRY RUN — sin escribir. APPLY=true para aplicar.");
    return;
  }

  const mod = await updatePaymentMethodInQb(TXN_ID, COMMISSION_CREDIT_QB_PAYMENT_METHOD, (m) => console.log(m));
  if (!mod.success || !mod.data?.operationId) throw new Error(`Mod no encolado: ${mod.success ? "sin opId" : mod.error}`);
  console.log(`encolado op=${mod.data.operationId}`);
  // pollOperationResult LANZA si QB rechaza el Mod (status failed) — no hay success:false.
  const result = await pollOperationResult(mod.data.operationId, (m) => console.log(m));
  console.log(`QB confirmó op=${result.operationId} txn=${result.txnId ?? "?"} editSeq=${result.editSequence ?? "?"}`);

  const after = await readPayment();
  console.log("QB después:", after);
  const ok =
    after.method === COMMISSION_CREDIT_QB_PAYMENT_METHOD &&
    after.total === before.total &&
    after.unused === before.unused &&
    after.depositTo === before.depositTo &&
    after.customerListId === before.customerListId;
  if (!ok) throw new Error("VERIFICACIÓN FALLÓ: algo más que el método cambió (ver snapshots)");
  console.log(`✅ ${TXN_ID}: método "${before.method}" → "${after.method}"; monto, unused, deposit y customer intactos.`);
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
