/**
 * GET    /admin/factory-orders/:id  — header + lines + receipts
 * PATCH  /admin/factory-orders/:id  — update draft (lines replaced)
 * DELETE /admin/factory-orders/:id  — cancel draft
 *
 * stock_location_id is always China Warehouse — PATCH ignores any attempt to
 * change it. No QB sync logic anywhere in this file.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import type { IUserModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getActorUserId, UnauthenticatedError } from "../_lib/auth";
import { zodErrorToBody } from "../_lib/format";
import { getFactoryOrdersService } from "../_lib/service-resolver";
import { computeTotals, normalizeLine } from "../_lib/totals";
import { updateDraftSchema } from "../_lib/validators";
import { resolveVendorDisplayName } from "../../../../lib/vendors/vendor-display-name";

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

async function resolveVendorSnapshot(
  req: AuthenticatedMedusaRequest,
  vendorId: string
): Promise<{ name: string; qb_list_id: string | null }> {
  try {
    const qbCatalog = req.scope.resolve(
      "quickbooks_catalog"
    ) as unknown as QbCatalogServiceLike;
    const vendor = await qbCatalog.retrieveQbVendor(vendorId);
    return {
      name: resolveVendorDisplayName(vendor ?? {}, vendorId) ?? vendorId,
      qb_list_id: vendor?.qb_list_id ?? null,
    };
  } catch {
    return { name: vendorId, qb_list_id: null };
  }
}

async function resolveUserBrief(
  req: AuthenticatedMedusaRequest,
  userId: string | null | undefined
): Promise<{
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
} | null> {
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

interface FoHeader {
  id: string;
  status: string;
  stock_location_id: string;
  vendor_id: string;
  cancelled_at?: Date | string | null;
  number?: string | null;
  draft_number?: string | null;
  vendor_name_snapshot?: string | null;
  vendor_list_id_snapshot?: string | null;
  ordered_at?: Date | string | null;
  expected_at?: Date | string | null;
  memo?: string | null;
  reference_number?: string | null;
  metadata?: Record<string, unknown> | null;
}

async function loadFo(
  service: ReturnType<typeof getFactoryOrdersService>,
  id: string
): Promise<FoHeader | null> {
  return (await service
    .retrieveFactoryOrder(id)
    .catch(() => null)) as unknown as FoHeader | null;
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const service = getFactoryOrdersService(req);

  const fo = await loadFo(service, id);
  if (!fo) {
    return res
      .status(404)
      .json({ error: "Factory order not found", code: "not_found" });
  }

  const lines = (await service.listFactoryOrderLines(
    { factory_order_id: id },
    { take: 1000, skip: 0, order: { line_order: "ASC", created_at: "ASC" } }
  )) as Array<Record<string, unknown>>;

  const receipts = (await service.listFactoryOrderReceipts(
    { factory_order_id: id },
    { take: 1000, skip: 0, order: { received_at: "DESC" } }
  )) as Array<Record<string, unknown> & { id: string }>;

  const receiptIds = receipts.map((r) => r.id);
  const receiptLines =
    receiptIds.length > 0
      ? ((await service.listFactoryOrderReceiptLines(
          { factory_order_receipt_id: receiptIds },
          { take: 10000, skip: 0 }
        )) as Array<
          Record<string, unknown> & { factory_order_receipt_id: string }
        >)
      : [];

  const linesByReceipt = new Map<string, Array<Record<string, unknown>>>();
  for (const rl of receiptLines) {
    const arr = linesByReceipt.get(rl.factory_order_receipt_id) ?? [];
    arr.push(rl);
    linesByReceipt.set(rl.factory_order_receipt_id, arr);
  }

  // Hydrate receipt user briefs for Activity timeline
  const receiptUserIds = Array.from(
    new Set(
      receipts.flatMap((r) => {
        const ids: string[] = [];
        const recv = (r as { received_by_user_id?: string | null })
          .received_by_user_id;
        const vd = (r as { voided_by_user_id?: string | null })
          .voided_by_user_id;
        if (recv) ids.push(recv);
        if (vd) ids.push(vd);
        return ids;
      })
    )
  );
  const userBriefById = new Map<
    string,
    Awaited<ReturnType<typeof resolveUserBrief>>
  >();
  await Promise.all(
    receiptUserIds.map(async (uid) => {
      userBriefById.set(uid, await resolveUserBrief(req, uid));
    })
  );

  const decoratedReceipts = receipts.map((r) => {
    const recvId = (r as { received_by_user_id?: string | null })
      .received_by_user_id;
    const voidId = (r as { voided_by_user_id?: string | null })
      .voided_by_user_id;
    return {
      ...r,
      lines: linesByReceipt.get(r.id) ?? [],
      received_by_user: recvId ? (userBriefById.get(recvId) ?? null) : null,
      voided_by_user: voidId ? (userBriefById.get(voidId) ?? null) : null,
    };
  });

  // Hydrate vendor contact info
  const vendor = await (async () => {
    try {
      const qbCatalog = req.scope.resolve(
        "quickbooks_catalog"
      ) as unknown as QbCatalogServiceLike;
      return await qbCatalog.retrieveQbVendor(fo.vendor_id);
    } catch {
      return null;
    }
  })();

  const creator = await resolveUserBrief(
    req,
    (fo as unknown as { created_by_user_id?: string | null }).created_by_user_id
  );
  const submitter = await resolveUserBrief(
    req,
    (fo as unknown as { submitted_by_user_id?: string | null })
      .submitted_by_user_id
  );
  const voider = await resolveUserBrief(
    req,
    (fo as unknown as { voided_by_user_id?: string | null }).voided_by_user_id
  );

  // Line thumbnails + MPN — batched variant lookup
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
      const knex = (req.scope as unknown as {
        resolve: (k: string) => {
          raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
        };
      }).resolve("__pg_connection__");
      const rows = await knex
        .raw(
          `SELECT pv.id, p.thumbnail, pv.metadata->>'mpn' AS mpn
             FROM product_variant pv
             LEFT JOIN product p ON p.id = pv.product_id
            WHERE pv.id = ANY(?)`,
          [variantIds]
        )
        .then(
          (r) =>
            r.rows as Array<{ id: string; thumbnail: string | null; mpn: string | null }>
        );
      for (const row of rows) {
        thumbnailByVariantId.set(row.id, row.thumbnail ?? null);
        mpnByVariantId.set(row.id, row.mpn ?? null);
      }
    } catch {
      // Non-fatal — thumbnail/MPN are display-only
    }
  }

  const decoratedLines = lines.map((l) => {
    const vid = (l as { product_variant_id?: string | null }).product_variant_id;
    return {
      ...l,
      thumbnail: vid ? (thumbnailByVariantId.get(vid) ?? null) : null,
      mpn: vid ? (mpnByVariantId.get(vid) ?? null) : null,
    };
  });

  const rawLinkedIds = (fo as unknown as { linked_order_ids?: string | null })
    .linked_order_ids;
  const linked_order_ids: string[] = (() => {
    if (!rawLinkedIds) return [];
    try {
      return JSON.parse(rawLinkedIds) as string[];
    } catch {
      return [];
    }
  })();

  return res.json({
    factory_order: {
      ...fo,
      linked_order_ids,
      lines: decoratedLines,
      receipts: decoratedReceipts,
      vendor,
      creator,
      submitter,
      voider,
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
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = updateDraftSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getFactoryOrdersService(req);

  const existing = await loadFo(service, id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Factory order not found", code: "not_found" });
  }

  // FO editability mirrors the Purchase Order (2026-06-03): draft, submitted,
  // partially_received AND received all allow line edits, gated only by the
  // per-item guard below (a received line can't be deleted, qty_ordered can't
  // drop below qty_received). Only the truly terminal states are frozen.
  // Editing qty_ordered never moves inventory — stock only moves on receive —
  // so allowing received-FO edits is inventory-safe. The reservation guard for
  // the receipt side lives in the FO receipt workflows.
  const FROZEN_STATUSES = ["closed", "cancelled", "voided"];
  const {
    po_status: bodyPoStatus,
    shipping_method: bodyShippingMethod,
    payment_terms: bodyPaymentTerms,
    ...bodyRest
  } = body;
  const hasNonStatusChanges = Object.values(bodyRest).some((v) => v !== undefined);
  if (hasNonStatusChanges && FROZEN_STATUSES.includes(existing.status)) {
    return res.status(409).json({
      error: `Cannot edit a Factory Order in status '${existing.status}'. Closed/cancelled/voided FOs are frozen.`,
      code: "not_editable",
    });
  }

  const vendorSnapshot =
    body.vendor_id !== undefined
      ? await resolveVendorSnapshot(req, body.vendor_id)
      : null;

  const headerUpdate: Record<string, unknown> = { id };
  if (bodyPoStatus !== undefined) headerUpdate.po_status = bodyPoStatus ?? null;
  if (body.vendor_id !== undefined) {
    headerUpdate.vendor_id = body.vendor_id;
    headerUpdate.vendor_name_snapshot = vendorSnapshot?.name ?? body.vendor_id;
    headerUpdate.vendor_list_id_snapshot =
      vendorSnapshot?.qb_list_id ?? null;
  }
  // stock_location_id intentionally NOT patchable — always China Warehouse
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
  if (body.metadata !== undefined) {
    headerUpdate.metadata = body.metadata
      ? { ...(existing.metadata ?? {}), ...body.metadata }
      : null;
  }
  if (body.linked_order_ids !== undefined) {
    headerUpdate.linked_order_ids = body.linked_order_ids?.length
      ? JSON.stringify(body.linked_order_ids)
      : null;
  }

  if (body.lines !== undefined) {
    // Diff-reconciliation by id (mirrors PO PATCH route, 2026-05-12). The
    // old full delete + re-insert wiped qty_received to 0 and changed every
    // line id on every PATCH — silently corrupting partially-received FOs.
    const oldLines = (await service.listFactoryOrderLines(
      { factory_order_id: id },
      { take: 1000, skip: 0 }
    )) as Array<Record<string, unknown> & { id: string }>;
    const oldIds = new Set(oldLines.map((l) => l.id));

    const oldById = new Map(oldLines.map((l) => [l.id, l]));

    const normalized = body.lines.map(normalizeLine);
    const totals = computeTotals(normalized, {
      shipping_cents:
        body.shipping_cents ??
        (existing as { shipping_cents?: number }).shipping_cents,
      tax_cents:
        body.tax_cents ?? (existing as { tax_cents?: number }).tax_cents,
      other_fees_cents:
        body.other_fees_cents ??
        (existing as { other_fees_cents?: number }).other_fees_cents,
    });

    const toUpdate: Array<{ id: string; data: Record<string, unknown> }> = [];
    const toInsert: Array<Record<string, unknown>> = [];
    const keepIds = new Set<string>();

    normalized.forEach((l, i) => {
      const lineFields = {
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
        qty_ordered: l.qty_ordered,
        unit_cost_cents: l.unit_cost_cents,
        tax_cents: l.tax_cents ?? 0,
        total_cents: l.total_cents,
        line_order: l.line_order ?? i,
        notes: l.notes ?? null,
      };
      if (l.id && oldIds.has(l.id)) {
        keepIds.add(l.id);
        // Recompute this line's receive status against the (possibly new)
        // qty_ordered. Editing qty_ordered does NOT touch qty_received, so a
        // line edited down to its received count must flip open/partial →
        // complete (and a received line edited up flips complete → partial).
        // Mirrors purchase-orders PATCH + persist-fo-receipt-step.
        const qtyRecv = Number(oldById.get(l.id)?.qty_received ?? 0);
        const lineStatus =
          qtyRecv === 0
            ? "open"
            : qtyRecv < Number(lineFields.qty_ordered)
              ? "partial"
              : "complete";
        toUpdate.push({ id: l.id, data: { ...lineFields, status: lineStatus } });
      } else {
        toInsert.push({
          factory_order_id: id,
          ...lineFields,
          qty_received: 0,
          qty_cancelled: 0,
          status: "open",
        });
      }
    });

    const toDeleteLines = oldLines.filter((l) => !keepIds.has(l.id));
    const toDelete = toDeleteLines.map((l) => l.id);

    // Per-item guard: a line with received units cannot be deleted, and
    // qty_ordered cannot drop below qty_received. Mirrors PO route.ts.
    {
      type OldLine = Record<string, unknown> & { id: string };
      const lineErrors: string[] = [];
      for (const dl of toDeleteLines as OldLine[]) {
        const qtyRecv = Number(dl.qty_received ?? 0);
        if (qtyRecv > 0) {
          lineErrors.push(
            `"${dl.sku_snapshot ?? dl.id}" has ${qtyRecv} received unit(s) and cannot be deleted.`
          );
        }
      }
      for (const u of toUpdate) {
        const old = (oldLines as OldLine[]).find((ol) => ol.id === u.id);
        if (!old) continue;
        const qtyRecv = Number(old.qty_received ?? 0);
        const sku = old.sku_snapshot ?? old.id;
        if (Number(u.data.qty_ordered) < qtyRecv) {
          lineErrors.push(
            `"${sku}": qty_ordered cannot go below qty_received (${qtyRecv}).`
          );
        }
        // Identity freeze: once a line has received units, stock has already
        // moved for THAT item — the line cannot be re-pointed to a different
        // product/variant/inventory_item (would desync receipts, stock history
        // and on-order math). Only qty/cost/description stay editable.
        if (qtyRecv > 0) {
          if (
            u.data.product_variant_id !== old.product_variant_id ||
            u.data.inventory_item_id !== old.inventory_item_id
          ) {
            lineErrors.push(
              `"${sku}": cannot change the product/variant of a line with ${qtyRecv} received unit(s).`
            );
          }
        }
      }
      if (lineErrors.length > 0) {
        return res.status(409).json({
          error: `Cannot apply line changes: ${lineErrors.join(" ")}`,
          code: "line_locked",
          details: lineErrors,
        });
      }
    }

    if (toDelete.length > 0) {
      await service.deleteFactoryOrderLines(toDelete);
    }
    if (toUpdate.length > 0) {
      await service.updateFactoryOrderLines(
        toUpdate.map((u) => ({ id: u.id, ...u.data }))
      );
    }
    if (toInsert.length > 0) {
      await service.createFactoryOrderLines(toInsert);
    }

    headerUpdate.subtotal_cents = totals.subtotal_cents;
    headerUpdate.tax_cents = totals.tax_cents;
    headerUpdate.shipping_cents = totals.shipping_cents;
    headerUpdate.other_fees_cents = totals.other_fees_cents;
    headerUpdate.total_cents = totals.total_cents;
    headerUpdate.total_lines = totals.total_lines;
    headerUpdate.total_units_ordered = totals.total_units_ordered;

    // Recompute header receive status. Editing lines never changes
    // total_units_received (received lines can't be deleted and qty_ordered
    // can't drop below qty_received — see per-item guard above). But:
    //  - lowering qty_ordered on a partially_received FO down to its received
    //    count makes it fully `received`;
    //  - raising qty_ordered on a `received` FO makes it `partially_received`
    //    again.
    // Without this the FO status freezes out of sync. Mirrors the PO route.
    const RECEIVE_LIFECYCLE = ["submitted", "partially_received", "received"];
    if (RECEIVE_LIFECYCLE.includes(existing.status)) {
      const totalReceived = Number(
        (existing as { total_units_received?: number }).total_units_received ?? 0
      );
      if (totalReceived > 0) {
        headerUpdate.status =
          totalReceived >= totals.total_units_ordered
            ? "received"
            : "partially_received";
      }
    }
  } else {
    const touchesExtras =
      body.shipping_cents !== undefined ||
      body.tax_cents !== undefined ||
      body.other_fees_cents !== undefined;
    if (touchesExtras) {
      const currentLines = (await service.listFactoryOrderLines(
        { factory_order_id: id },
        { take: 1000, skip: 0 }
      )) as Array<{ qty_ordered: number; unit_cost_cents: number; tax_cents: number }>;
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

  const [updated] = await service.updateFactoryOrders([headerUpdate]);
  return res.json({ factory_order: updated });
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
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const service = getFactoryOrdersService(req);

  const existing = await loadFo(service, id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Factory order not found", code: "not_found" });
  }
  if (existing.status !== "draft") {
    return res.status(409).json({
      error: `Cannot cancel a Factory Order in status '${existing.status}'. Only drafts are cancellable here.`,
      code: "not_cancellable",
    });
  }

  await service.updateFactoryOrders([
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
