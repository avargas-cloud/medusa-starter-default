import type FactoryOrdersModuleService from "../../../../modules/factory-orders/service";

export interface ReceiptsQueryParams {
  limit: number;
  offset: number;
  status?: string;
  fo_id?: string;
  date_from?: string;
  date_to?: string;
}

export async function listReceiptsCrossFo(
  service: FactoryOrdersModuleService,
  params: ReceiptsQueryParams
) {
  const filters: Record<string, unknown> = {};
  if (params.status) filters.status = params.status;
  if (params.fo_id) filters.factory_order_id = params.fo_id;

  const allReceipts = (await service.listFactoryOrderReceipts(filters, {
    take: params.limit,
    skip: params.offset,
    order: { received_at: "DESC" },
  })) as Array<
    Record<string, unknown> & {
      id: string;
      factory_order_id: string;
      seq: number | null;
    }
  >;

  // Apply date filters client-side
  const filtered = allReceipts.filter((r) => {
    const receivedAt = r.received_at ? new Date(r.received_at as string) : null;
    if (params.date_from && receivedAt && receivedAt < new Date(params.date_from))
      return false;
    if (
      params.date_to &&
      receivedAt &&
      receivedAt > new Date(params.date_to + "T23:59:59Z")
    )
      return false;
    return true;
  });

  if (filtered.length === 0) return { receipts: [], count: 0 };

  // Batch-fetch receipt lines for total_units_received
  const receiptIds = filtered.map((r) => r.id);
  const allLines = (await service.listFactoryOrderReceiptLines(
    { factory_order_receipt_id: receiptIds },
    { take: 50000, skip: 0 }
  )) as Array<
    Record<string, unknown> & {
      factory_order_receipt_id: string;
      qty_received_now: number;
    }
  >;

  const linesByReceipt = new Map<string, typeof allLines>();
  for (const l of allLines) {
    const arr = linesByReceipt.get(l.factory_order_receipt_id) ?? [];
    arr.push(l);
    linesByReceipt.set(l.factory_order_receipt_id, arr);
  }

  // Batch-fetch parent FOs (deduplicated)
  const foIds = [...new Set(filtered.map((r) => r.factory_order_id))];
  const parentFos = (await service.listFactoryOrders(
    { id: foIds },
    { take: foIds.length, skip: 0 }
  )) as Array<
    Record<string, unknown> & {
      id: string;
      number: string | null;
      vendor_name_snapshot: string | null;
    }
  >;

  const foById = new Map(parentFos.map((fo) => [fo.id, fo]));

  const receipts = filtered.map((r) => {
    const lines = linesByReceipt.get(r.id) ?? [];
    const fo = foById.get(r.factory_order_id);
    const totalUnitsReceived = lines.reduce(
      (sum, l) => sum + (l.qty_received_now ?? 0),
      0
    );

    // Real factory/manufacturer (distinct from the buying-agent vendor, e.g.
    // Veetech). Mirrors the FO editor's Manufacturer field.
    const meta = (fo?.metadata ?? {}) as Record<string, unknown>;
    const manufacturer =
      (meta.manufacturer_vendor_short_name as string) ||
      (meta.manufacturer_vendor_name as string) ||
      null;

    return {
      ...r,
      total_units_received: totalUnitsReceived,
      line_count: lines.length,
      fo_number: fo?.number ?? null,
      vendor_snapshot: fo?.vendor_name_snapshot
        ? { name: fo.vendor_name_snapshot as string }
        : null,
      manufacturer,
    };
  });

  return { receipts, count: receipts.length };
}
