/**
 * Refresh the cached QB EditSequence (and TxnLineIDs by SKU) for a Purchase
 * Order after it was edited manually in QB Desktop (e.g. template change).
 *
 * A manual edit in QB Desktop bumps the PO's EditSequence, invalidating our
 * cached `purchase_order.qb_edit_sequence`. This does NOT block a fresh
 * ItemReceiptAdd (receiving links to the PO via TxnID/TxnLineID only, no
 * EditSequence needed) — but a later PurchaseOrderMod (line edit, status
 * sync) using the stale value would fail with QB 3200/3100. This queries
 * the live PO, logs current vs cached state, and re-caches it so any
 * pending/future Mod starts from a fresh value instead of relying on the
 * poller's query-then-retry auto-heal (qb-purchase-order-poller.ts).
 *
 * Usage:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/debug/refresh-po-editseq.ts <po_number|txn_id>
 */
import { bridgeFetch, pollRawOperationResult } from "../../lib/quickbooks/client/core";

export default async function refreshPoEditSequence({
  container,
  args,
}: {
  container: any;
  args: string[];
}) {
  const arg = args?.[0];
  const log = (m: string) => console.log(`[refresh-po-editseq] ${m}`);
  if (!arg) throw new Error("Usage: refresh-po-editseq.ts <po_number|txn_id>");

  const pg = container.resolve("__pg_connection__") as any;

  const { rows } = await pg.raw(
    `SELECT id, number, qb_purchase_order_list_id, qb_purchase_order_txn_number, qb_edit_sequence
       FROM purchase_order
      WHERE number = ? OR qb_purchase_order_list_id = ? OR qb_purchase_order_txn_number = ?
      LIMIT 1`,
    [arg, arg, arg]
  );
  const po = rows?.[0];
  if (!po) throw new Error(`No purchase_order matched "${arg}"`);

  const txnId = po.qb_purchase_order_list_id;
  if (!txnId) throw new Error(`PO ${po.number} has no qb_purchase_order_list_id — not synced to QB yet`);

  log(`PO ${po.number} — TxnID=${txnId} — cached EditSequence=${po.qb_edit_sequence ?? "∅"}`);
  log(`Querying live QB PurchaseOrder TxnID=${txnId} ...`);

  const res: any = await bridgeFetch("POST", "/api/purchase-orders/query", { txn_id: txnId, po_id: po.id });
  const operationId: string = res?.operationId || res?.operation?.id;
  if (!operationId) throw new Error("Bridge did not return an operationId");

  const raw: any = await pollRawOperationResult(operationId, log);
  const msgs = raw?.QBXML?.QBXMLMsgsRs ?? raw?.QBXMLMsgsRs ?? raw ?? {};
  const retRaw = msgs?.PurchaseOrderQueryRs?.PurchaseOrderRet ?? raw?.PurchaseOrderRet ?? null;
  const ret: any = Array.isArray(retRaw) ? retRaw[0] : retRaw;
  if (!ret) throw new Error(`QB returned no PurchaseOrderRet for TxnID=${txnId} — PO may have been deleted`);

  const editSequence: string | undefined = ret.EditSequence;
  const isManuallyClosed: string | undefined = ret.IsManuallyClosed;
  const refNumber: string | undefined = ret.RefNumber;

  log(`RefNumber          = ${refNumber ?? "∅"}`);
  log(`IsManuallyClosed   = ${isManuallyClosed ?? "false"}`);
  log(`EditSequence(live) = ${editSequence ?? "∅"}`);
  log(`EditSequence(cache)= ${po.qb_edit_sequence ?? "∅"}`);

  if (!editSequence) throw new Error("QB response has no EditSequence");

  if (String(editSequence) === String(po.qb_edit_sequence)) {
    log(`✅ Cache already matches live QB — no drift, nothing to fix`);
  } else {
    log(`⚠️  Cache was STALE (template edit likely bumped it) — refreshing now`);
  }

  await pg.raw(
    `UPDATE purchase_order
        SET qb_edit_sequence = ?, qb_purchase_order_txn_number = COALESCE(?, qb_purchase_order_txn_number), qb_synced_at = NOW(), updated_at = NOW()
      WHERE id = ?`,
    [editSequence, refNumber, po.id]
  );
  log(`✅ purchase_order.qb_edit_sequence refreshed → ${editSequence}`);

  // Report + repair line TxnLineIDs by SKU (ItemRef.FullName), matching the
  // poller's line-recovery mapping. A template change alone should not move
  // these, but we verify rather than assume.
  const lineRets = ret.PurchaseOrderLineRet;
  const lines = lineRets ? (Array.isArray(lineRets) ? lineRets : [lineRets]) : [];
  let mismatches = 0;
  for (const l of lines) {
    const sku = l.ItemRef?.FullName as string | undefined;
    const txnLineId = l.TxnLineID as string | undefined;
    if (!sku || !txnLineId) continue;
    const { rows: lineRows } = await pg.raw(
      `SELECT id, qb_txn_line_id FROM purchase_order_line WHERE purchase_order_id = ? AND sku_snapshot = ?`,
      [po.id, sku]
    );
    for (const lr of lineRows) {
      if (lr.qb_txn_line_id !== txnLineId) {
        mismatches++;
        log(`  line ${sku}: DB TxnLineID=${lr.qb_txn_line_id ?? "∅"} → live=${txnLineId} (updating)`);
        await pg.raw(`UPDATE purchase_order_line SET qb_txn_line_id = ?, updated_at = NOW() WHERE id = ?`, [
          txnLineId,
          lr.id,
        ]);
      }
    }
  }
  log(`Line TxnLineID check: ${lines.length} live lines, ${mismatches} mismatch(es) repaired`);
  log(`Done.`);
}
