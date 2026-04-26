/**
 * src/api/admin/purchase-orders/_lib/receipts-query.ts
 *
 * Cross-PO receipt list query. Returns receipts with embedded PO metadata
 * (po_number, vendor_snapshot) so the Receive Items page never needs to
 * join client-side across multiple fetches.
 */

import type PurchaseOrdersModuleService from "../../../../modules/purchase-orders/service";

export interface ReceiptsQueryParams {
  limit: number;
  offset: number;
  status?: string;
  po_id?: string;
  date_from?: string;
  date_to?: string;
}

export async function listReceiptsCrossPo(
  service: PurchaseOrdersModuleService,
  params: ReceiptsQueryParams
) {
  const filters: Record<string, unknown> = {};
  if (params.status) filters.status = params.status;
  if (params.po_id) filters.purchase_order_id = params.po_id;

  const allReceipts = (await service.listPurchaseOrderReceipts(filters, {
    take: params.limit,
    skip: params.offset,
    order: { received_at: "DESC" },
  })) as Array<
    Record<string, unknown> & {
      id: string;
      purchase_order_id: string;
      seq: number | null;
    }
  >;

  // Apply date filters client-side (Medusa service layer doesn't support range filters)
  const filtered = allReceipts.filter((r) => {
    const receivedAt = r.received_at ? new Date(r.received_at as string) : null;
    if (
      params.date_from &&
      receivedAt &&
      receivedAt < new Date(params.date_from)
    )
      return false;
    if (
      params.date_to &&
      receivedAt &&
      receivedAt > new Date(params.date_to + "T23:59:59Z")
    )
      return false;
    return true;
  });

  if (filtered.length === 0) {
    return { receipts: [], count: 0 };
  }

  // Batch-fetch receipt lines for total_units_received
  const receiptIds = filtered.map((r) => r.id);
  const allLines = (await service.listPurchaseOrderReceiptLines(
    { purchase_order_receipt_id: receiptIds },
    { take: 50000, skip: 0 }
  )) as Array<
    Record<string, unknown> & {
      purchase_order_receipt_id: string;
      qty_received_now: number;
    }
  >;

  const linesByReceipt = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const arr = linesByReceipt.get(l.purchase_order_receipt_id) ?? [];
    arr.push(l);
    linesByReceipt.set(l.purchase_order_receipt_id, arr);
  }

  // Batch-fetch parent POs (deduplicated)
  const poIds = [...new Set(filtered.map((r) => r.purchase_order_id))];
  const parentPos = (await service.listPurchaseOrders(
    { id: poIds },
    { take: poIds.length, skip: 0 }
  )) as Array<
    Record<string, unknown> & {
      id: string;
      number: string | null;
      seq: number | null;
      vendor_name_snapshot: string | null;
    }
  >;

  const poById = new Map(parentPos.map((po) => [po.id, po]));

  const receipts = filtered.map((r) => {
    const lines = linesByReceipt.get(r.id) ?? [];
    const po = poById.get(r.purchase_order_id);
    const totalUnitsReceived = lines.reduce(
      (sum, l) => sum + (l.qty_received_now ?? 0),
      0
    );

    return {
      ...r,
      total_units_received: totalUnitsReceived,
      line_count: lines.length,
      po_number: po?.number ?? null,
      vendor_snapshot: po?.vendor_name_snapshot
        ? { name: po.vendor_name_snapshot as string }
        : null,
    };
  });

  return { receipts, count: receipts.length };
}
