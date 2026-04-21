/**
 * src/api/admin/purchase-orders/[id]/route.ts
 *
 * GET    /admin/purchase-orders/:id  — header + lines + receipts
 * PATCH  /admin/purchase-orders/:id  — update draft (lines replaced)
 * DELETE /admin/purchase-orders/:id  — cancel draft (only status='draft')
 *
 * Only drafts are mutable. Once a PO is submitted, the header + lines
 * are frozen — receive / close / void actions live in sibling routes.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../_lib/auth";
import { zodErrorToBody } from "../_lib/format";
import { getPurchaseOrdersService } from "../_lib/service-resolver";
import { computeTotals, normalizeLine } from "../_lib/totals";
import { updateDraftSchema } from "../_lib/validators";

interface PoHeader {
  id: string;
  status: string;
  stock_location_id: string;
  vendor_id: string;
  cancelled_at?: Date | string | null;
}

async function loadPo(
  service: ReturnType<typeof getPurchaseOrdersService>,
  id: string
): Promise<PoHeader | null> {
  return (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as unknown as PoHeader | null;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const service = getPurchaseOrdersService(req);

  const po = await loadPo(service, id);
  if (!po) {
    return res.status(404).json({ error: "Purchase order not found", code: "not_found" });
  }

  const lines = (await service.listPurchaseOrderLines(
    { purchase_order_id: id },
    { take: 1000, skip: 0, order: { line_order: "ASC", created_at: "ASC" } }
  )) as Array<Record<string, unknown>>;

  const receipts = (await service.listPurchaseOrderReceipts(
    { purchase_order_id: id },
    { take: 1000, skip: 0, order: { received_at: "DESC" } }
  )) as Array<Record<string, unknown> & { id: string }>;

  // Fetch receipt lines for all receipts in one batched call
  const receiptIds = receipts.map((r) => r.id);
  const receiptLines =
    receiptIds.length > 0
      ? ((await service.listPurchaseOrderReceiptLines(
          { purchase_order_receipt_id: receiptIds },
          { take: 10000, skip: 0 }
        )) as Array<Record<string, unknown> & { purchase_order_receipt_id: string }>)
      : [];

  const linesByReceipt = new Map<string, Array<Record<string, unknown>>>();
  for (const rl of receiptLines) {
    const arr = linesByReceipt.get(rl.purchase_order_receipt_id) ?? [];
    arr.push(rl);
    linesByReceipt.set(rl.purchase_order_receipt_id, arr);
  }

  const decoratedReceipts = receipts.map((r) => ({
    ...r,
    lines: linesByReceipt.get(r.id) ?? [],
  }));

  return res.json({
    purchase_order: {
      ...po,
      lines,
      receipts: decoratedReceipts,
    },
  });
}

export async function PATCH(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = updateDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getPurchaseOrdersService(req);

  const existing = await loadPo(service, id);
  if (!existing) {
    return res.status(404).json({ error: "Purchase order not found", code: "not_found" });
  }
  if (existing.status !== "draft") {
    return res.status(409).json({
      error: `Cannot edit a PO in status '${existing.status}'. Only drafts are mutable.`,
      code: "not_editable",
    });
  }

  // Header patch
  const headerUpdate: Record<string, unknown> = { id };
  if (body.vendor_id !== undefined) headerUpdate.vendor_id = body.vendor_id;
  if (body.stock_location_id !== undefined)
    headerUpdate.stock_location_id = body.stock_location_id;
  if (body.ordered_at !== undefined)
    headerUpdate.ordered_at = body.ordered_at ? new Date(body.ordered_at) : null;
  if (body.expected_at !== undefined)
    headerUpdate.expected_at = body.expected_at ? new Date(body.expected_at) : null;
  if (body.memo !== undefined) headerUpdate.memo = body.memo ?? null;
  if (body.reference_number !== undefined)
    headerUpdate.reference_number = body.reference_number ?? null;

  // Replace lines if provided
  if (body.lines !== undefined) {
    const oldLines = (await service.listPurchaseOrderLines(
      { purchase_order_id: id },
      { take: 1000, skip: 0 }
    )) as Array<{ id: string }>;
    if (oldLines.length > 0) {
      await service.deletePurchaseOrderLines(oldLines.map((l) => l.id));
    }

    const normalized = body.lines.map(normalizeLine);
    const totals = computeTotals(normalized, {
      shipping_cents: body.shipping_cents ?? (existing as { shipping_cents?: number }).shipping_cents,
      tax_cents: body.tax_cents ?? (existing as { tax_cents?: number }).tax_cents,
      other_fees_cents:
        body.other_fees_cents ?? (existing as { other_fees_cents?: number }).other_fees_cents,
    });

    if (normalized.length > 0) {
      await service.createPurchaseOrderLines(
        normalized.map((l, i) => ({
          purchase_order_id: id,
          product_variant_id: l.product_variant_id,
          inventory_item_id: l.inventory_item_id,
          sku_snapshot: l.sku_snapshot,
          description_snapshot: l.description_snapshot,
          qb_item_list_id_snapshot: l.qb_item_list_id_snapshot ?? null,
          qty_ordered: l.qty_ordered,
          qty_received: 0,
          qty_cancelled: 0,
          unit_cost_cents: l.unit_cost_cents,
          tax_cents: l.tax_cents ?? 0,
          total_cents: l.total_cents,
          status: "open",
          line_order: l.line_order ?? i,
          notes: l.notes ?? null,
        }))
      );
    }

    headerUpdate.subtotal_cents = totals.subtotal_cents;
    headerUpdate.tax_cents = totals.tax_cents;
    headerUpdate.shipping_cents = totals.shipping_cents;
    headerUpdate.other_fees_cents = totals.other_fees_cents;
    headerUpdate.total_cents = totals.total_cents;
    headerUpdate.total_lines = totals.total_lines;
    headerUpdate.total_units_ordered = totals.total_units_ordered;
  } else {
    // If only shipping/tax/fees changed, refresh total_cents
    const touchesExtras =
      body.shipping_cents !== undefined ||
      body.tax_cents !== undefined ||
      body.other_fees_cents !== undefined;
    if (touchesExtras) {
      const currentLines = (await service.listPurchaseOrderLines(
        { purchase_order_id: id },
        { take: 1000, skip: 0 }
      )) as Array<{
        qty_ordered: number;
        unit_cost_cents: number;
        tax_cents: number;
      }>;
      const subtotal = currentLines.reduce(
        (a, l) => a + l.qty_ordered * l.unit_cost_cents,
        0
      );
      const lineTax = currentLines.reduce((a, l) => a + (l.tax_cents ?? 0), 0);
      const ship = body.shipping_cents ?? 0;
      const tax = (body.tax_cents ?? 0) + lineTax;
      const other = body.other_fees_cents ?? 0;
      headerUpdate.subtotal_cents = subtotal;
      headerUpdate.tax_cents = tax;
      headerUpdate.shipping_cents = ship;
      headerUpdate.other_fees_cents = other;
      headerUpdate.total_cents = subtotal + tax + ship + other;
    }
  }

  const [updated] = await service.updatePurchaseOrders([headerUpdate]);
  return res.json({ purchase_order: updated });
}

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const service = getPurchaseOrdersService(req);

  const existing = await loadPo(service, id);
  if (!existing) {
    return res.status(404).json({ error: "Purchase order not found", code: "not_found" });
  }
  if (existing.status !== "draft") {
    return res.status(409).json({
      error: `Cannot cancel a PO in status '${existing.status}'. Only drafts are cancellable here; submitted POs must be closed or voided.`,
      code: "not_cancellable",
    });
  }

  // Soft-cancel: mark status + audit fields. Lines stay for history.
  await service.updatePurchaseOrders([
    {
      id,
      status: "cancelled",
      cancelled_at: new Date(),
      cancelled_by_user_id: userId,
      cancel_reason: "Draft cancelled by user",
    },
  ]);

  return res.status(204).end();
}
