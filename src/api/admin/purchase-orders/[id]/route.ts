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
import type { IUserModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { getActorUserId, UnauthenticatedError } from "../_lib/auth";
import { zodErrorToBody } from "../_lib/format";
import { getPurchaseOrdersService } from "../_lib/service-resolver";
import { computeTotals, normalizeLine } from "../_lib/totals";
import { updateDraftSchema } from "../_lib/validators";
import { orderPurchaseOrderModLines } from "../../../../lib/quickbooks/purchase-order-line-order";
import { rebuildTransferChinaReservations } from "../../../../lib/inventory-transfer-reservations";

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

function poMemoNumber(poNumber: string): string {
  return poNumber.replace(/^PO-/i, "");
}

function hasPatchKey(patch: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key);
}

function nullableValue(value: unknown): unknown {
  return value ?? null;
}

function headerPatchRequiresQbMod(
  patch: Record<string, unknown>,
  existing: PoHeader & Record<string, unknown>
): boolean {
  const qbRelevantHeaderFields = [
    "vendor_id",
    "stock_location_id",
    "memo",
    "reference_number",
    "shipping_cents",
    "tax_cents",
    "other_fees_cents",
  ];

  return qbRelevantHeaderFields.some(
    (key) =>
      hasPatchKey(patch, key) &&
      nullableValue(patch[key]) !== nullableValue(existing[key])
  );
}

function linesPatchRequiresQbMod(
  patchLines: ReturnType<typeof normalizeLine>[],
  existingLines: Array<Record<string, unknown> & { id: string }>
): boolean {
  if (patchLines.length !== existingLines.length) return true;

  const existingById = new Map(existingLines.map((line) => [line.id, line]));
  return patchLines.some((line, index) => {
    if (!line.id) return true;
    const existing = existingById.get(line.id);
    if (!existing) return true;

    const comparisons: Array<[unknown, unknown]> = [
      [line.product_variant_id, existing.product_variant_id],
      [line.inventory_item_id, existing.inventory_item_id],
      [line.sku_snapshot, existing.sku_snapshot],
      [line.description_snapshot, existing.description_snapshot],
      [
        nullableValue(line.qb_item_list_id_snapshot),
        nullableValue(existing.qb_item_list_id_snapshot),
      ],
      [line.qty_ordered, existing.qty_ordered],
      [line.unit_cost_cents, existing.unit_cost_cents],
      [line.tax_cents ?? 0, existing.tax_cents ?? 0],
      [line.line_order ?? index, existing.line_order ?? index],
      [nullableValue(line.notes), nullableValue(existing.notes)],
    ];

    return comparisons.some(([next, current]) => next !== current);
  });
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

interface PoHeader {
  id: string;
  status: string;
  stock_location_id: string;
  vendor_id: string;
  cancelled_at?: Date | string | null;
  number?: string | null;
  draft_number?: string | null;
  vendor_name_snapshot?: string | null;
  vendor_qb_list_id_snapshot?: string | null;
  ordered_at?: Date | string | null;
  expected_at?: Date | string | null;
  memo?: string | null;
  reference_number?: string | null;
  qb_purchase_order_list_id?: string | null;
  qb_edit_sequence?: string | null;
  qb_purchase_order_txn_number?: string | null;
  qb_synced_at?: Date | string | null;
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
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }

  const lines = (await service.listPurchaseOrderLines(
    { purchase_order_id: id },
    { take: 1000, skip: 0, order: { line_order: "ASC", created_at: "ASC" } }
  )) as Array<Record<string, unknown>>;

  const receiptsRaw = (await service.listPurchaseOrderReceipts(
    { purchase_order_id: id },
    { take: 1000, skip: 0, order: { received_at: "DESC" } }
  )) as Array<Record<string, unknown> & { id: string; status?: string }>;
  // Tombstoned receipts (status='deleted') are pending QB DELETE sync — hide
  // from UI so the user perceives the delete as instant.
  const receipts = receiptsRaw.filter((r) => r.status !== "deleted");

  // Fetch receipt lines for all receipts in one batched call
  const receiptIds = receipts.map((r) => r.id);
  const receiptLines =
    receiptIds.length > 0
      ? ((await service.listPurchaseOrderReceiptLines(
          { purchase_order_receipt_id: receiptIds },
          { take: 10000, skip: 0 }
        )) as Array<
          Record<string, unknown> & { purchase_order_receipt_id: string }
        >)
      : [];

  const billedByReceiptLineId = new Map<string, { vendor_bill_id: string; vendor_bill_number: string | null }>();
  const billedQtyByPoLineId = new Map<string, number>();
  if (receiptLines.length > 0) {
    const receiptLineIds = receiptLines.map((rl) => rl.id).filter(Boolean);
    const knex = (req.scope as any).resolve("__pg_connection__");
    const billedRows: Array<{
      receipt_line_id: string;
      purchase_order_line_id: string;
      qty_received_now: number;
      vendor_bill_id: string;
      vendor_bill_number: string | null;
    }> = await knex.raw(
      `SELECT
         porl.id AS receipt_line_id,
         porl.purchase_order_line_id,
         porl.qty_received_now,
         vb.id AS vendor_bill_id,
         vb.number AS vendor_bill_number
       FROM purchase_order_receipt_line porl
       JOIN vendor_bill_line vbl
         ON vbl.receipt_line_id = porl.id
        AND vbl.deleted_at IS NULL
       JOIN vendor_bill vb
         ON vb.id = vbl.vendor_bill_id
        AND vb.deleted_at IS NULL
        AND vb.status NOT IN ('cancelled', 'voided')
       WHERE porl.id = ANY(?)`,
      [receiptLineIds]
    ).then((r: any) => r.rows);

    for (const row of billedRows) {
      billedByReceiptLineId.set(row.receipt_line_id, {
        vendor_bill_id: row.vendor_bill_id,
        vendor_bill_number: row.vendor_bill_number,
      });
      billedQtyByPoLineId.set(
        row.purchase_order_line_id,
        (billedQtyByPoLineId.get(row.purchase_order_line_id) ?? 0) + Number(row.qty_received_now ?? 0)
      );
    }
  }

  const linesByReceipt = new Map<string, Array<Record<string, unknown>>>();
  for (const rl of receiptLines) {
    const billed = billedByReceiptLineId.get(rl.id as string) ?? null;
    const decoratedReceiptLine = {
      ...rl,
      vendor_bill_id: billed?.vendor_bill_id ?? null,
      vendor_bill_number: billed?.vendor_bill_number ?? null,
      billing_status: billed ? "billed" : "unbilled",
      is_billed: Boolean(billed),
    };
    const arr = linesByReceipt.get(rl.purchase_order_receipt_id) ?? [];
    arr.push(decoratedReceiptLine);
    linesByReceipt.set(rl.purchase_order_receipt_id, arr);
  }

  // Hydrate received_by + voided_by user briefs so the Activity timeline can
  // render names instead of opaque user_ids. Batched: collect unique IDs first,
  // resolve once, then attach by ID.
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
      const brief = await resolveUserBrief(req, uid);
      userBriefById.set(uid, brief);
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
    (po as unknown as { submitted_by_user_id?: string | null })
      .submitted_by_user_id
  );
  const voider = await resolveUserBrief(
    req,
    (po as unknown as { voided_by_user_id?: string | null }).voided_by_user_id
  );

  // Line thumbnails — batched variant lookup. Variant thumbnail wins; product
  // thumbnail is only a fallback for variants without a specific image.
  const variantIds = Array.from(
    new Set(
      lines
        .map(
          (l) =>
            (l as { product_variant_id?: string | null }).product_variant_id
        )
        .filter((v): v is string => !!v)
    )
  );
  const thumbnailByVariantId = new Map<string, string | null>();
  const mpnByVariantId = new Map<string, string | null>();
  if (variantIds.length > 0) {
    try {
      // Raw SQL — Medusa v2's listProductVariants doesn't reliably hydrate metadata
      const knex = (req.scope as any).resolve("__pg_connection__");
      const rows: Array<{ id: string; thumbnail: string | null; mpn: string | null }> =
        await knex.raw(
          `SELECT pv.id,
                  COALESCE(pv.thumbnail, p.thumbnail) AS thumbnail,
                  pv.metadata->>'mpn' AS mpn
             FROM product_variant pv
             LEFT JOIN product p ON p.id = pv.product_id
            WHERE pv.id = ANY(?)`,
          [variantIds]
        ).then((r: any) => r.rows);
      for (const row of rows) {
        thumbnailByVariantId.set(row.id, row.thumbnail ?? null);
        mpnByVariantId.set(row.id, row.mpn ?? null);
      }
    } catch {
      // Non-fatal — thumbnail and MPN are display-only
    }
  }

  const decoratedLines = lines.map((l) => {
    const vid = (l as { product_variant_id?: string | null })
      .product_variant_id;
    const lineId = l.id as string;
    const qtyReceived = Number((l as { qty_received?: number }).qty_received ?? 0);
    const billedQty = billedQtyByPoLineId.get(lineId) ?? 0;
    const billingStatus =
      billedQty <= 0 ? "unbilled" : billedQty >= qtyReceived ? "billed" : "partially_billed";
    return {
      ...l,
      thumbnail: vid ? (thumbnailByVariantId.get(vid) ?? null) : null,
      mpn: vid ? (mpnByVariantId.get(vid) ?? null) : null,
      billed_qty: billedQty,
      unbilled_received_qty: Math.max(0, qtyReceived - billedQty),
      billing_status: billingStatus,
    };
  });

  const rawLinkedIds = (po as unknown as { linked_order_ids?: string | null })
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
    purchase_order: {
      ...po,
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

  const service = getPurchaseOrdersService(req);

  const existing = await loadPo(service, id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }

  // Terminal states (received, closed, cancelled, voided) are fully frozen.
  // Draft, submitted, and partially_received allow full edits (submitted/partial
  // require a supervisor PIN on the frontend; backend trusts the caller).
  const TERMINAL_STATUSES = ["received", "closed", "cancelled", "voided"];
  const {
    po_status: bodyPoStatus,
    shipping_method: bodyShippingMethod,
    payment_terms: bodyPaymentTerms,
    ...bodyRest
  } = body;
  const hasNonStatusChanges = Object.values(bodyRest).some(
    (v) => v !== undefined
  );
  if (hasNonStatusChanges && TERMINAL_STATUSES.includes(existing.status)) {
    return res.status(409).json({
      error: `Cannot edit a PO in status '${existing.status}'. Terminal POs are frozen.`,
      code: "not_editable",
    });
  }

  // If vendor is changing, refresh name/QB snapshots from the catalog
  let vendorSnapshot: { name: string; qb_list_id: string | null } | null = null;
  if (body.vendor_id !== undefined) {
    try {
      const qbCatalog = req.scope.resolve(
        "quickbooks_catalog"
      ) as unknown as QbCatalogServiceLike;
      const v = await qbCatalog.retrieveQbVendor(body.vendor_id);
      vendorSnapshot = {
        name: v?.full_name ?? v?.name ?? body.vendor_id,
        qb_list_id: v?.qb_list_id ?? null,
      };
    } catch {
      vendorSnapshot = { name: body.vendor_id, qb_list_id: null };
    }
  }

  // Header patch
  const headerUpdate: Record<string, unknown> = { id };
  if (bodyPoStatus !== undefined) headerUpdate.po_status = bodyPoStatus ?? null;
  if (body.vendor_id !== undefined) {
    headerUpdate.vendor_id = body.vendor_id;
    headerUpdate.vendor_name_snapshot = vendorSnapshot?.name ?? body.vendor_id;
    headerUpdate.vendor_qb_list_id_snapshot = vendorSnapshot?.qb_list_id ?? null;
  }
  if (body.stock_location_id !== undefined)
    headerUpdate.stock_location_id = body.stock_location_id?.trim() ?? body.stock_location_id;
  if (body.ordered_at !== undefined)
    headerUpdate.ordered_at = body.ordered_at
      ? new Date(body.ordered_at)
      : null;
  if (body.expected_at !== undefined)
    headerUpdate.expected_at = body.expected_at
      ? new Date(body.expected_at)
      : null;
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

  let requiresQbMod = headerPatchRequiresQbMod(
    body,
    existing as PoHeader & Record<string, unknown>
  );

  // Reconcile lines if provided — DIFF by id (update existing, insert new,
  // delete missing) instead of full hard-delete + re-insert. This preserves
  // each line's qb_txn_line_id so subsequent QB Mods can target the existing
  // QuickBooks line items by their TxnLineID; otherwise QB sees Mod requests
  // with TxnLineID=-1 on every line and adds duplicate lines while leaving
  // the originals as ghosts (qty=0). See incident: "On PO" cache drift on
  // ENEA1-18-30 / ENEA1-18-60 (May 2026).
  if (body.lines !== undefined) {
    const oldLines = (await service.listPurchaseOrderLines(
      { purchase_order_id: id },
      { take: 1000, skip: 0 }
    )) as Array<Record<string, unknown> & { id: string }>;
    const oldIds = new Set(oldLines.map((l) => l.id));

    const normalized = body.lines.map(normalizeLine);
    if (!requiresQbMod) {
      requiresQbMod = linesPatchRequiresQbMod(normalized, oldLines);
    }
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

    // Partition body lines: those with a known existing id → update;
    // those without (or with an unknown id) → insert.
    const toUpdate: Array<{ id: string; data: Record<string, unknown> }> = [];
    const toInsert: Array<Record<string, unknown>> = [];
    const keepIds = new Set<string>();

    normalized.forEach((l, i) => {
      const lineFields = {
        product_variant_id: l.product_variant_id,
        inventory_item_id: l.inventory_item_id,
        sku_snapshot: l.sku_snapshot,
        description_snapshot: l.description_snapshot,
        qb_item_list_id_snapshot: l.qb_item_list_id_snapshot ?? null,
        qty_ordered: l.qty_ordered,
        unit_cost_cents: l.unit_cost_cents,
        tax_cents: l.tax_cents ?? 0,
        total_cents: l.total_cents,
        line_order: l.line_order ?? i,
        notes: l.notes ?? null,
      };
      if (l.id && oldIds.has(l.id)) {
        keepIds.add(l.id);
        toUpdate.push({ id: l.id, data: lineFields });
      } else {
        toInsert.push({
          purchase_order_id: id,
          ...lineFields,
          qty_received: 0,
          qty_cancelled: 0,
          status: "open",
        });
      }
    });

    // Anything not kept gets hard-deleted.
    const toDeleteLines = oldLines.filter((l) => !keepIds.has(l.id));
    const toDelete = toDeleteLines.map((l) => l.id);

    // Per-item guard: block only the affected lines, not the whole PO.
    // A line with any received units cannot be deleted; a fully-received
    // line cannot be modified; qty_ordered cannot drop below qty_received.
    {
      type OldLine = Record<string, unknown> & { id: string };
      const lineErrors: string[] = [];
      for (const dl of toDeleteLines as OldLine[]) {
        const qtyRecv = Number(dl.qty_received ?? 0);
        if (qtyRecv > 0) {
          lineErrors.push(`"${dl.sku_snapshot ?? dl.id}" has ${qtyRecv} received unit(s) and cannot be deleted.`);
        }
      }
      for (const u of toUpdate) {
        const old = (oldLines as OldLine[]).find((ol) => ol.id === u.id);
        if (!old) continue;
        const qtyRecv = Number(old.qty_received ?? 0);
        const sku = old.sku_snapshot ?? old.id;
        if (Number(u.data.qty_ordered) < qtyRecv) {
          lineErrors.push(`"${sku}": qty_ordered cannot go below qty_received (${qtyRecv}).`);
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
      await service.deletePurchaseOrderLines(toDelete);
    }
    if (toUpdate.length > 0) {
      await service.updatePurchaseOrderLines(
        toUpdate.map((u) => ({ id: u.id, ...u.data }))
      );
    }
    if (toInsert.length > 0) {
      await service.createPurchaseOrderLines(toInsert);
    }

    // Sync China reservations when lines are removed or qty is reduced.
    // A linked inventory_transfer holds reservation_items in China; without
    // this sync, deleting a PO line leaves orphan reservations indefinitely.
    const qtyChangedUpdates = toUpdate.filter((u) => {
      const old = oldLines.find((ol) => ol.id === u.id);
      return old && Number(old.qty_ordered) !== Number(u.data.qty_ordered);
    });
    if (toDelete.length > 0 || qtyChangedUpdates.length > 0) {
      try {
        const knex = (req.scope as any).resolve("__pg_connection__") as {
          raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
        };
        const transferResult = await knex.raw(
          `SELECT id FROM inventory_transfer WHERE linked_purchase_order_id = ? AND deleted_at IS NULL LIMIT 1`,
          [id]
        );
        const linkedTransfer = transferResult.rows[0] as { id: string } | undefined;

        if (linkedTransfer) {
          const transferId = linkedTransfer.id;

          for (const oldLine of oldLines.filter((l) => toDelete.includes(l.id))) {
            await knex.raw(
              `UPDATE inventory_transfer_line
                  SET deleted_at = NOW(), updated_at = NOW()
                WHERE transfer_id = ?
                  AND product_variant_id = ?
                  AND deleted_at IS NULL`,
              [transferId, oldLine.product_variant_id]
            );
          }

          for (const upd of qtyChangedUpdates) {
            await knex.raw(
              `UPDATE inventory_transfer_line
                  SET qty = ?, updated_at = NOW()
                WHERE transfer_id = ?
                  AND product_variant_id = ?
                  AND deleted_at IS NULL`,
              [upd.data.qty_ordered, transferId, upd.data.product_variant_id]
            );
          }

          await rebuildTransferChinaReservations(knex, transferId, id);
        }
      } catch (transferErr) {
        console.error("[po-patch] Failed to sync China transfer reservations:", transferErr);
      }
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
        (a, l) => a + Math.round(l.qty_ordered * l.unit_cost_cents),
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

  // If the PO is submitted/partially_received and already synced to QB,
  // queue a MOD operation so QuickBooks reflects the changes.
  // Use `existing` (pre-update full fetch) for QB fields — updatePurchaseOrders()
  // returns a partial object that does not hydrate qb_purchase_order_list_id.
  const EDITABLE_SYNCED_STATUSES = ["submitted", "partially_received"];
  if (
    EDITABLE_SYNCED_STATUSES.includes(existing.status) &&
    existing.qb_purchase_order_list_id &&
    requiresQbMod
  ) {
    try {
      // Fetch fresh lines (with their qb_txn_line_id if available)
      const freshLines = (await service.listPurchaseOrderLines(
        { purchase_order_id: id },
        { take: 1000, skip: 0, order: { line_order: "ASC", created_at: "ASC" } }
      )) as Array<{
        id: string;
        sku_snapshot: string;
        description_snapshot: string;
        qty_ordered: number;
        unit_cost_cents: number;
        qb_item_list_id_snapshot: string | null;
        qb_txn_line_id: string | null;
      }>;

      const modPayload = {
        is_mod: true,
        txn_id: existing.qb_purchase_order_list_id,
        edit_sequence: existing.qb_edit_sequence ?? undefined,
        po_id: id,
        po_number: existing.number ?? undefined,
        vendor_qb_list_id:
          body.vendor_id !== undefined
            ? (vendorSnapshot?.qb_list_id ?? null)
            : (existing.vendor_qb_list_id_snapshot ?? null),
        vendor_name:
          body.vendor_id !== undefined
            ? (vendorSnapshot?.name ?? body.vendor_id)
            : (existing.vendor_name_snapshot ?? existing.vendor_id),
        ordered_at: existing.ordered_at
          ? new Date(
              existing.ordered_at as unknown as string | Date
            ).toISOString()
          : null,
        expected_at: existing.expected_at
          ? new Date(
              existing.expected_at as unknown as string | Date
            ).toISOString()
          : null,
        memo: `Medusa PO ${poMemoNumber(existing.number ?? id)}`,
        reference_number: existing.reference_number ?? null,
        lines: orderPurchaseOrderModLines(freshLines).map((l) => ({
          line_id: l.id,
          qb_txn_line_id: l.qb_txn_line_id ?? null,
          qb_item_list_id: l.qb_item_list_id_snapshot,
          sku: l.sku_snapshot,
          description: l.description_snapshot,
          qty_ordered: l.qty_ordered,
          unit_cost_cents: l.unit_cost_cents,
        })),
      };

      // Reset existing pipeline row to waiting, or create one if this PO has never been queued.
      // Medusa enforces uniqueness at service level (no DB constraint), so we use raw UPDATE first.
      const knex = (req.scope as any).resolve("__pg_connection__");
      const updated = await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET status          = 'waiting',
                qb_operation_id = NULL,
                payload         = ?,
                retries         = 0,
                last_error      = NULL,
                next_retry_at   = NULL,
                synced_at       = NULL,
                updated_at      = NOW()
          WHERE purchase_order_id = ?
            AND deleted_at IS NULL`,
        [JSON.stringify(modPayload), id]
      );
      if ((updated.rowCount ?? 0) === 0) {
        await service.createQbPurchaseOrderPipelines([
          { purchase_order_id: id, status: "waiting", payload: modPayload },
        ]);
      }
    } catch (qbErr) {
      // Non-fatal: the local save succeeded; QB MOD will be retried next session
      console.error("[po-patch] Failed to enqueue QB MOD:", qbErr);
    }
  }

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
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const service = getPurchaseOrdersService(req);

  const existing = await loadPo(service, id);
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
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
