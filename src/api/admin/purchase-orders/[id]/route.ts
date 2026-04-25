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
import { Modules } from "@medusajs/utils";
import type { IUserModuleService } from "@medusajs/framework/types";

import { getActorUserId, UnauthenticatedError } from "../_lib/auth";
import { zodErrorToBody } from "../_lib/format";
import { getPurchaseOrdersService } from "../_lib/service-resolver";
import { computeTotals, normalizeLine } from "../_lib/totals";
import { updateDraftSchema } from "../_lib/validators";

interface QbVendorLike {
  id: string;
  qb_list_id: string | null;
  full_name: string | null;
  name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  addr1: string | null;
  addr2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

interface QbCatalogServiceLike {
  retrieveQbVendor: (id: string) => Promise<QbVendorLike | null>;
}

interface ProductVariantLike {
  id: string;
  metadata?: Record<string, unknown> | null;
  product?: { thumbnail?: string | null } | null;
}

interface ProductModuleLike {
  listProductVariants: (
    where: Record<string, unknown>,
    config?: { relations?: string[] }
  ) => Promise<ProductVariantLike[]>;
}

async function resolveUserBrief(
  req: AuthenticatedMedusaRequest,
  userId: string | null | undefined
): Promise<{ id: string; first_name: string | null; last_name: string | null; email: string | null } | null> {
  if (!userId) return null;
  try {
    const userModule = req.scope.resolve(Modules.USER) as IUserModuleService;
    const user = (await userModule.retrieveUser(userId)) as unknown as {
      id: string;
      first_name?: string | null;
      last_name?: string | null;
      email?: string | null;
    } | null;
    if (!user) return null;
    return {
      id: user.id,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      email: user.email ?? null,
    };
  } catch {
    return null;
  }
}

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

  // ── Hydrations for the editor: vendor contact, creator/actor users,
  //    product variant thumbnails so refresh shows everything the picker did.
  const vendor = await (async () => {
    try {
      const qbCatalog = req.scope.resolve(
        "quickbooks_catalog"
      ) as unknown as QbCatalogServiceLike;
      return await qbCatalog.retrieveQbVendor(po.vendor_id);
    } catch {
      return null;
    }
  })();

  const creator = await resolveUserBrief(
    req,
    (po as unknown as { created_by_user_id?: string | null }).created_by_user_id
  );
  const submitter = await resolveUserBrief(
    req,
    (po as unknown as { submitted_by_user_id?: string | null }).submitted_by_user_id
  );

  // Line thumbnails — batched variant lookup
  const variantIds = Array.from(
    new Set(
      lines
        .map((l) => (l as { product_variant_id?: string | null }).product_variant_id)
        .filter((v): v is string => !!v)
    )
  );
  const thumbnailByVariantId = new Map<string, string | null>();
  const mpnByVariantId = new Map<string, string | null>();
  if (variantIds.length > 0) {
    try {
      const productModule = req.scope.resolve(
        Modules.PRODUCT
      ) as unknown as ProductModuleLike;
      const variants = await productModule.listProductVariants(
        { id: variantIds },
        { relations: ["product"] }
      );
      for (const v of variants) {
        thumbnailByVariantId.set(v.id, v.product?.thumbnail ?? null);
        const mpn = v.metadata?.mpn;
        mpnByVariantId.set(v.id, typeof mpn === "string" ? mpn : null);
      }
    } catch {
      // Silent — thumbnails are decorative; missing thumbnails fall back to a placeholder.
    }
  }

  const decoratedLines = lines.map((l) => {
    const vid = (l as { product_variant_id?: string | null }).product_variant_id;
    return {
      ...l,
      thumbnail: vid ? thumbnailByVariantId.get(vid) ?? null : null,
      mpn: vid ? mpnByVariantId.get(vid) ?? null : null,
    };
  });

  const rawLinkedIds = (po as unknown as { linked_order_ids?: string | null }).linked_order_ids;
  const linked_order_ids: string[] = (() => {
    if (!rawLinkedIds) return [];
    try { return JSON.parse(rawLinkedIds) as string[]; } catch { return []; }
  })();

  return res.json({
    purchase_order: {
      ...po,
      linked_order_ids,
      lines: decoratedLines,
      receipts: decoratedReceipts,
      vendor,
      creator,
      submitter,
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

  // `po_status`, `shipping_method`, and `payment_terms` are coordination/info
  // fields editable at any lifecycle stage. All other fields require status='draft'.
  const { po_status: bodyPoStatus, shipping_method: bodyShippingMethod, payment_terms: bodyPaymentTerms, ...bodyRest } = body;
  const hasNonStatusChanges = Object.values(bodyRest).some((v) => v !== undefined);
  if (hasNonStatusChanges && existing.status !== "draft") {
    return res.status(409).json({
      error: `Cannot edit a PO in status '${existing.status}'. Only drafts are mutable (po_status, shipping_method, and payment_terms are always editable).`,
      code: "not_editable",
    });
  }

  // Header patch
  const headerUpdate: Record<string, unknown> = { id };
  if (bodyPoStatus !== undefined) headerUpdate.po_status = bodyPoStatus ?? null;
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
  if (bodyShippingMethod !== undefined)
    headerUpdate.shipping_method = bodyShippingMethod ?? null;
  if (bodyPaymentTerms !== undefined)
    headerUpdate.payment_terms = bodyPaymentTerms ?? null;
  if (body.linked_order_ids !== undefined) {
    headerUpdate.linked_order_ids = body.linked_order_ids?.length
      ? JSON.stringify(body.linked_order_ids)
      : null;
  }

  // Replace lines if provided — hard-delete (no soft-delete / version history
  // so removed items vanish from the PO entirely). MedusaService's deleteXXX
  // already does a hard delete (softDeleteXXX is a separate method).
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
