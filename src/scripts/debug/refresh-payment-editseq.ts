/**
 * Refresh the cached QB EditSequence for a ReceivePayment after its TxnDate
 * (or any field) was edited manually in QB Desktop.
 *
 * Manual edits in QB bump the EditSequence, invalidating our cached value in
 * qb_edit_sequence_cache. A later apply/mod using the stale value would fail
 * with "The object ... has been modified ... please refresh". This queries the
 * live payment, logs the current TxnDate + EditSequence, and re-caches it.
 *
 * Usage:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx -y tsx src/scripts/debug/refresh-payment-editseq.ts <TxnID>
 */
import { bridgeFetch, pollRawOperationResult } from "../../lib/quickbooks/client/core";
import { cacheEditSequence } from "../../lib/quickbooks/pipeline/edit-sequence";
import { getDbPool } from "../../api/utils/db-pool";

async function main() {
  const txnId = process.argv[2] || "1C928B-1783281682"; // #3030 default
  const log = (m: string) => console.log(`[refresh-editseq] ${m}`);

  log(`Querying live QB ReceivePayment TxnID=${txnId} ...`);
  const res: any = await bridgeFetch("GET", `/api/payments/${txnId}`);
  const operationId: string = res?.operationId || res?.operation?.id;
  if (!operationId) throw new Error("Bridge did not return an operationId");

  const raw: any = await pollRawOperationResult(operationId, log);
  const msgs = raw?.QBXML?.QBXMLMsgsRs ?? raw?.QBXMLMsgsRs ?? raw ?? {};
  const retRaw =
    msgs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
    raw?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
    raw?.ReceivePaymentRet ??
    null;
  const ret: any = Array.isArray(retRaw) ? retRaw[0] : retRaw;
  if (!ret) throw new Error(`QB returned no ReceivePaymentRet for TxnID=${txnId}`);

  const editSequence: string | undefined = ret?.EditSequence;
  const txnDate: string | undefined = ret?.TxnDate;
  const totalAmount: string | undefined = ret?.TotalAmount;

  log(`TxnDate     = ${txnDate ?? "∅"}`);
  log(`TotalAmount = ${totalAmount ?? "∅"}`);
  log(`EditSequence(live) = ${editSequence ?? "∅"}`);

  if (!editSequence) throw new Error("QB response has no EditSequence");

  const pool = getDbPool();
  const before = await pool.query(
    `SELECT edit_seq, cached_at FROM qb_edit_sequence_cache WHERE entity_type='payment' AND qb_id=$1`,
    [txnId]
  );
  log(`EditSequence(cache, before) = ${before.rows[0]?.edit_seq ?? "∅"}`);

  await cacheEditSequence("payment", txnId, String(editSequence));
  log(`✅ Cache refreshed → edit_seq=${editSequence}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[refresh-editseq] ❌", e?.message || e);
    process.exit(1);
  });
