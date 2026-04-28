/**
 * GET /admin/factory-orders/on-order?sku=XXX
 * GET /admin/factory-orders/on-order?sku[]=XXX&sku[]=YYY
 *
 * Returns pending qty in active factory orders for one or more SKUs.
 * Single SKU: { on_order: number }
 * Multi SKU:  { on_order: Record<string, number> }
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getFactoryOrdersService } from "../_lib/service-resolver";

const ACTIVE_STATUSES = ["submitted", "partially_received"] as const;
const ACTIVE_LINE_STATUSES = ["open", "partial"] as const;

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const skuParam = req.query["sku"] as string | string[] | undefined;
  const skus: string[] = Array.isArray(skuParam)
    ? skuParam.map((s) => s.trim()).filter(Boolean)
    : skuParam?.trim()
      ? [skuParam.trim()]
      : [];

  if (!skus.length) {
    return res.status(400).json({ error: "sku query param is required" });
  }

  const service = getFactoryOrdersService(req);

  const filter =
    skus.length === 1 ? { sku_snapshot: skus[0] } : { sku_snapshot: skus };
  const lines = (await service.listFactoryOrderLines(filter, {
    take: 5000,
    skip: 0,
  })) as Array<{
    factory_order_id: string;
    sku_snapshot: string;
    qty_ordered: number;
    qty_received: number;
    qty_cancelled: number;
    status: string;
  }>;

  if (!lines.length) {
    if (skus.length === 1) return res.json({ on_order: 0 });
    const empty: Record<string, number> = {};
    for (const s of skus) empty[s] = 0;
    return res.json({ on_order: empty });
  }

  const foIds = [...new Set(lines.map((l) => l.factory_order_id))];
  const activeFOs = new Set<string>();
  try {
    const fos = (await service.listFactoryOrders(
      { id: foIds, status: ACTIVE_STATUSES },
      { take: 1000, skip: 0 }
    )) as Array<{ id: string }>;
    for (const fo of fos) activeFOs.add(fo.id);
  } catch {
    if (skus.length === 1) return res.json({ on_order: 0 });
    const empty: Record<string, number> = {};
    for (const s of skus) empty[s] = 0;
    return res.json({ on_order: empty });
  }

  if (skus.length === 1) {
    let onOrder = 0;
    for (const line of lines) {
      if (!activeFOs.has(line.factory_order_id)) continue;
      if (!(ACTIVE_LINE_STATUSES as readonly string[]).includes(line.status))
        continue;
      const pending = line.qty_ordered - line.qty_received - line.qty_cancelled;
      if (pending > 0) onOrder += pending;
    }
    return res.json({ on_order: onOrder });
  }

  const result: Record<string, number> = {};
  for (const s of skus) result[s] = 0;
  for (const line of lines) {
    if (!activeFOs.has(line.factory_order_id)) continue;
    if (!(ACTIVE_LINE_STATUSES as readonly string[]).includes(line.status))
      continue;
    const pending = line.qty_ordered - line.qty_received - line.qty_cancelled;
    if (pending > 0 && line.sku_snapshot && line.sku_snapshot in result) {
      result[line.sku_snapshot] = (result[line.sku_snapshot] ?? 0) + pending;
    }
  }
  return res.json({ on_order: result });
}
