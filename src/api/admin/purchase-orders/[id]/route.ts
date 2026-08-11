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
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../lib/pos/verify-supervisor-pin";
import type { IUserModuleService } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import { randomUUID } from "crypto";

import { generateEntityId } from "@medusajs/utils";

import { getActorUserId, UnauthenticatedError } from "../_lib/auth";
import { deriveChinaTransferState, vendorIsChinaAgent } from "../_lib/china-transfer";
import { zodErrorToBody } from "../_lib/format";
import { getPurchaseOrdersService } from "../_lib/service-resolver";
import { resolveNonReceivableReasons } from "../_lib/receivability";
import { computeTotals, normalizeLine } from "../_lib/totals";
import { updateDraftSchema } from "../_lib/validators";
import { orderPurchaseOrderModLines } from "../../../../lib/quickbooks/purchase-order-line-order";
import { rebuildTransferChinaReservations } from "../../../../lib/inventory-transfer-reservations";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../workflows/sync-inventory-item-meilisearch";
import {
  poHasTracking,
  reconcileReceivedPoStatus,
} from "../../../../lib/purchase-orders/po-received-status";
import { resolveVendorDisplayName } from "../../../../lib/vendors/vendor-display-name";
import {
  poLineChangeRejections,
  resolveLineAllocationClaims,
} from "../../../../lib/purchase-orders/po-tracking-line-guard";
import {
  poLineTrackingViews,
  resolvePoShipments,
  trackingCoverage,
} from "../../../../lib/purchase-orders/po-tracking-read";
import {
  enqueuePurchaseQbOperation,
  purchaseOperationKey,
} from "../../../../lib/purchase-orders/qb-purchase-dependency-chain";

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
  po_status?: string | null;
  tracking?: unknown;
  total_units_received?: number;
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
      billed_qty: number;
      vendor_bill_id: string;
      vendor_bill_number: string | null;
    }> = await knex.raw(
      `SELECT
         porl.id AS receipt_line_id,
         porl.purchase_order_line_id,
         vbl.qty AS billed_qty,
         vb.id AS vendor_bill_id,
         vb.number AS vendor_bill_number
       FROM purchase_order_receipt_line porl
       JOIN vendor_bill_line vbl
         ON vbl.receipt_line_id = porl.id
        AND vbl.deleted_at IS NULL
       JOIN vendor_bill vb
         ON vb.id = vbl.vendor_bill_id
        AND vb.deleted_at IS NULL
        AND vb.status NOT IN ('cancelled', 'voided', 'deleted')
       WHERE porl.id = ANY(?)`,
      [receiptLineIds]
    ).then((r: any) => r.rows);

    for (const row of billedRows) {
      billedByReceiptLineId.set(row.receipt_line_id, {
        vendor_bill_id: row.vendor_bill_id,
        vendor_bill_number: row.vendor_bill_number,
      });
    }
  }

  // Bill quantities belong to PO lines even when a legacy/header-bound Bill
  // has no receipt_line_id. Compute the PO editor's billed floor directly from
  // active regular bill lines so its warning modal matches the backend guard.
  const billingKnex = (req.scope as any).resolve("__pg_connection__");
  const billedTotals = await billingKnex.raw(
    `SELECT vbl.purchase_order_line_id,
            COALESCE(SUM(vbl.qty), 0)::int AS billed_qty
       FROM vendor_bill_line vbl
       JOIN vendor_bill vb
         ON vb.id = vbl.vendor_bill_id
        AND vb.deleted_at IS NULL
        AND vb.purchase_order_id = ?
        AND vb.bill_type = 'regular'
        AND vb.status IN ('draft', 'confirmed', 'synced')
      WHERE vbl.deleted_at IS NULL
        AND COALESCE(vbl.line_type, 'product') = 'product'
        AND vbl.purchase_order_line_id IS NOT NULL
      GROUP BY vbl.purchase_order_line_id`,
    [id]
  );
  for (const row of billedTotals.rows as Array<{
    purchase_order_line_id: string;
    billed_qty: number | string;
  }>) {
    billedQtyByPoLineId.set(
      row.purchase_order_line_id,
      Number(row.billed_qty ?? 0)
    );
  }

  // Vendor bill lines that cover each PO line. The PO editor uses this to ask
  // whether a unit-cost correction should also reach the bill it was raised
  // against — the mirror of the bill→PO propagation in the vendor-bill PATCH.
  // Only DRAFT bills are listed: a confirmed/synced bill has already moved
  // average costs and posted to QuickBooks, so its cost is not a field the PO
  // page may quietly rewrite (it takes Reopen → edit → Reconfirm).
  const billLinesByPoLineId = new Map<
    string,
    Array<{
      vendor_bill_id: string;
      vendor_bill_number: string | null;
      vendor_bill_reference_id: string | null;
      vendor_bill_document_date: string | null;
      vendor_bill_line_id: string;
      unit_cost_cents: number;
      qty: number;
      vendor_bill_item_subtotal_cents: number;
    }>
  >();
  const billLineRows = await billingKnex.raw(
    `SELECT vbl.id AS vendor_bill_line_id,
            vbl.purchase_order_line_id,
            vbl.unit_cost_cents::int AS unit_cost_cents,
            vbl.qty::int AS qty,
            vb.id AS vendor_bill_id,
            vb.number AS vendor_bill_number,
            vb.reference_id AS vendor_bill_reference_id,
            COALESCE(vb.document_date, vb.created_at) AS vendor_bill_document_date,
            -- The bill's "Item Total" exactly as its own page computes it:
            -- every live line except the server-owned tax charge (freight
            -- charges DO count — they are money owed on the document).
            (SELECT COALESCE(SUM(x.unit_cost_cents::bigint * x.qty), 0)::bigint
               FROM vendor_bill_line x
              WHERE x.vendor_bill_id = vb.id
                AND x.deleted_at IS NULL
                AND COALESCE(x.line_kind, 'po_item') <> 'tax_charge'
            ) AS vendor_bill_item_subtotal_cents
       FROM vendor_bill_line vbl
       JOIN vendor_bill vb
         ON vb.id = vbl.vendor_bill_id
        AND vb.deleted_at IS NULL
        AND vb.purchase_order_id = ?
        AND vb.bill_type = 'regular'
        AND vb.status = 'draft'
      WHERE vbl.deleted_at IS NULL
        AND COALESCE(vbl.line_type, 'product') = 'product'
        AND vbl.purchase_order_line_id IS NOT NULL
      ORDER BY vb.created_at ASC, vbl.created_at ASC`,
    [id]
  );
  for (const row of billLineRows.rows as Array<{
    vendor_bill_line_id: string;
    purchase_order_line_id: string;
    unit_cost_cents: number;
    qty: number;
    vendor_bill_id: string;
    vendor_bill_number: string | null;
    vendor_bill_reference_id: string | null;
    vendor_bill_document_date: string | Date | null;
    vendor_bill_item_subtotal_cents: number | string;
  }>) {
    const bucket = billLinesByPoLineId.get(row.purchase_order_line_id) ?? [];
    bucket.push({
      vendor_bill_id: row.vendor_bill_id,
      vendor_bill_number: row.vendor_bill_number,
      vendor_bill_reference_id: row.vendor_bill_reference_id,
      vendor_bill_document_date: row.vendor_bill_document_date
        ? new Date(row.vendor_bill_document_date).toISOString()
        : null,
      vendor_bill_line_id: row.vendor_bill_line_id,
      unit_cost_cents: Number(row.unit_cost_cents ?? 0),
      qty: Number(row.qty ?? 0),
      // bigint → string over the wire; coerce here, never at the callsite.
      vendor_bill_item_subtotal_cents: Number(
        row.vendor_bill_item_subtotal_cents ?? 0
      ),
    });
    billLinesByPoLineId.set(row.purchase_order_line_id, bucket);
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
  const productIdByVariantId = new Map<string, string | null>();
  if (variantIds.length > 0) {
    try {
      // Raw SQL — Medusa v2's listProductVariants doesn't reliably hydrate metadata
      const knex = (req.scope as any).resolve("__pg_connection__");
      const rows: Array<{
        id: string;
        thumbnail: string | null;
        mpn: string | null;
        product_id: string | null;
      }> = await knex.raw(
          `SELECT pv.id,
                  COALESCE(pv.thumbnail, p.thumbnail) AS thumbnail,
                  pv.metadata->>'mpn' AS mpn,
                  p.id AS product_id
             FROM product_variant pv
             LEFT JOIN product p ON p.id = pv.product_id
            WHERE pv.id = ANY(?)`,
          [variantIds]
        ).then((r: any) => r.rows);
      for (const row of rows) {
        thumbnailByVariantId.set(row.id, row.thumbnail ?? null);
        mpnByVariantId.set(row.id, row.mpn ?? null);
        productIdByVariantId.set(row.id, row.product_id ?? null);
      }
    } catch {
      // Non-fatal — thumbnail and MPN are display-only
    }
  }

  // Receivability: flag non-inventory / "Special Item" placeholder lines so the
  // receive UI can lock their qty input to 0 (QB rejects them with error 3153).
  const nonReceivableByVariant = new Map<string, string | null>();
  if (variantIds.length > 0) {
    try {
      const knex = (req.scope as any).resolve("__pg_connection__");
      const resolved = await resolveNonReceivableReasons(knex, variantIds);
      for (const [vid, reason] of resolved) {
        nonReceivableByVariant.set(vid, reason);
      }
    } catch {
      // Non-fatal — receivability is an advisory UI hint; the receive route
      // re-validates server-side regardless.
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
    const nonReceivableReasonForLine = vid
      ? (nonReceivableByVariant.get(vid) ?? null)
      : null;
    return {
      ...l,
      thumbnail: vid ? (thumbnailByVariantId.get(vid) ?? null) : null,
      mpn: vid ? (mpnByVariantId.get(vid) ?? null) : null,
      product_id: vid ? (productIdByVariantId.get(vid) ?? null) : null,
      billed_qty: billedQty,
      unbilled_received_qty: Math.max(0, qtyReceived - billedQty),
      billing_status: billingStatus,
      vendor_bill_lines: billLinesByPoLineId.get(lineId) ?? [],
      non_receivable: nonReceivableReasonForLine !== null,
      non_receivable_reason: nonReceivableReasonForLine,
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

  // Surface the linked InventoryTransfer (if any) so the UI can hide the
  // "Convert to Transfer" button once one exists. Voided ITs are ignored so a
  // re-conversion is allowed after a void.
  const linked_inventory_transfer = await (async () => {
    try {
      const knex = (req.scope as any).resolve("__pg_connection__");
      const r: { rows: Array<{ id: string; number: string | null; status: string }> } =
        await knex.raw(
          `SELECT id, number, status
             FROM inventory_transfer
            WHERE linked_purchase_order_id = ?
              AND status <> 'voided'
              AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1`,
          [id]
        );
      return r.rows[0] ?? null;
    } catch {
      return null;
    }
  })();

  // China-agent IT state: is this a PO to the buying agent, and does it still
  // lack its required Inventory Transfer? Derived live from the vendor flag.
  const china_transfer = await (async () => {
    try {
      const knex = (req.scope as any).resolve("__pg_connection__");
      const poLike = po as unknown as {
        status: string;
        total_units_received?: number | null;
        vendor_id: string;
      };
      const required = await vendorIsChinaAgent(knex, poLike.vendor_id);
      return deriveChinaTransferState({
        required,
        hasLinkedTransfer: Boolean(linked_inventory_transfer),
        status: poLike.status,
        unitsReceived: Number(poLike.total_units_received ?? 0),
      });
    } catch {
      return null;
    }
  })();

  // Inbound shipments come from purchase_order_tracking, NOT the PO's legacy
  // `tracking` JSON column — that column is frozen as the rollback path and is
  // no longer written, so serving it would show a stale list. Overriding it by
  // name (rather than deleting it) keeps the response shape the POS already
  // reads while making the value the true one.
  const trackingDb = req.scope.resolve("__pg_connection__") as {
    raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  };
  const trackingRows = await resolvePoShipments(trackingDb, id);
  // A whole-PO tracking stores no allocation rows — it means "everything here
  // travels in this box" — so the lines it covers can only come from the PO.
  // Without this the ETA column would sit empty on every PO that has not been
  // split, which is most of them.
  const lineTracking = poLineTrackingViews(
    trackingRows,
    decoratedLines.map((l) => {
      const line = l as { id?: string; qty_ordered?: number; qty_cancelled?: number };
      return {
        purchase_order_line_id: line.id ?? "",
        qty_ordered: Math.max(
          Number(line.qty_ordered ?? 0) - Number(line.qty_cancelled ?? 0),
          0
        ),
      };
    })
  );

  return res.json({
    purchase_order: {
      ...po,
      tracking: trackingRows,
      tracking_coverage: trackingCoverage(trackingRows),
      linked_order_ids,
      linked_inventory_transfer,
      china_transfer,
      // Each line carries the shipments covering it and their latest ETA — the
      // per-product arrival date this feature exists to produce. Independent of
      // the header's expected_at, which keeps its own (earliest-box) policy.
      lines: decoratedLines.map((line) => {
        const view = lineTracking.get((line as { id?: string }).id ?? "");
        return {
          ...line,
          tracking: view?.shipments ?? [],
          tracking_eta: view?.carrier_eta ?? null,
          tracking_qty_allocated: view?.qty_allocated ?? 0,
        };
      }),
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

  // PIN de supervisor para editar un documento YA ENVIADO. Un draft se edita
  // libre (todavia no salio a nadie); a partir de submitted el documento ya fue
  // comunicado al proveedor y su edicion mueve compromisos, por eso la pantalla
  // pedia PIN. Ese gate vivia SOLO en la UI y se comparaba en el navegador: un
  // PATCH directo a esta ruta editaba el documento sin encontrar ninguna puerta.
  //
  // La condicion la decide ESTA ruta leyendo el status, nunca el cliente.
  if (String((existing as { status?: string }).status ?? "") !== "draft") {
    const pinDb = req.scope.resolve("__pg_connection__") as unknown as PinConn;
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: pinDb,
      pin: extractSupervisorPin(req),
      actorId: resolveActorId(req),
    });
    if (!guard.ok) {
      const { status, body: pinBody } = pinGuardResponse(guard);
      return res.status(status).json({
        ...pinBody,
        document_status: (existing as { status?: string }).status ?? null,
      });
    }
  }


  // Terminal states (closed, cancelled, voided) are fully frozen.
  // Draft, submitted, partially_received AND received allow edits (the per-item
  // guard below still protects already-received lines). A `received` PO stays
  // editable so a new line can be added — that reopens it to partially_received
  // and drops the "Fully Received" po_status. QuickBooks accepts a line added to
  // an already-received PurchaseOrder (it just clears its received state).
  const TERMINAL_STATUSES = ["closed", "cancelled", "voided"];
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
        name: resolveVendorDisplayName(v ?? {}, body.vendor_id) ?? body.vendor_id,
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
  if (body.vendor_notes !== undefined)
    headerUpdate.vendor_notes = body.vendor_notes ?? null;
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

  /**
   * Reduced PO lines that a QuickBooks-resident Bill still claims.
   *
   * Filled by the billing checks inside the line-diff block, read at the QB
   * enqueue far below — hence the handler-level scope. Non-empty means the PO
   * Mod would be refused with error 3060 and is therefore NOT enqueued; the
   * response carries these lines so the POS can ask for the Bill to be
   * corrected and confirmed first. (2026-08-04)
   */
  const qbRepairRequired: Array<{
    po_line_id: string;
    sku: string;
    previous_qty: number;
    next_qty: number;
    vendor_bill_number: string | null;
  }> = [];

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
    const oldById = new Map(oldLines.map((l) => [l.id, l]));

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
        // Recompute this line's receive status against the (possibly new)
        // qty_ordered. Editing a line's quantity does NOT touch qty_received,
        // so a line edited down to its received count must flip open/partial
        // → complete. Mirrors persist-receipt-step.ts line-status logic.
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

    // A QB-linked Vendor Bill constrains the safe ordering of PO reductions.
    // The bill must already carry the desired lower quantity locally and must
    // have been reconfirmed before this PO save. Its BillMod then becomes the
    // dependency parent of the PurchaseOrderMod enqueued below.
    const reductions = [
      ...toUpdate
        .map((update) => {
          const old = oldById.get(update.id);
          const previousQty = Number(old?.qty_ordered ?? 0);
          const nextQty = Number(update.data.qty_ordered ?? 0);
          return {
            line_id: update.id,
            sku: String(old?.sku_snapshot ?? update.id),
            previous_qty: previousQty,
            next_qty: nextQty,
          };
        })
        .filter((line) => line.next_qty < line.previous_qty),
      ...toDeleteLines.map((line) => ({
        line_id: line.id,
        sku: String(line.sku_snapshot ?? line.id),
        previous_qty: Number(line.qty_ordered ?? 0),
        next_qty: 0,
      })),
    ];

    // An inbound shipment already claiming these units outranks the edit: a box
    // is on a truck carrying goods this save is about to delete or shrink away.
    // Refused, not cascaded — a silent cascade rewrites logistics with nothing
    // on screen saying which shipment just lost its cargo. Runs BEFORE any
    // mutation, and before the vendor-bill checks, because a stranded shipment
    // is cheaper to discover than a half-applied save.
    if (reductions.length > 0) {
      const trackingKnex = req.scope.resolve("__pg_connection__") as {
        raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const claims = await resolveLineAllocationClaims(
        trackingKnex,
        reductions.map((line) => line.line_id)
      );
      const trackingRejections = poLineChangeRejections(
        claims,
        reductions.map((line) => ({
          line_id: line.line_id,
          sku: line.sku,
          // qty_cancelled is not editable through this route, so the ceiling
          // after the edit is the new ordered qty minus what was already
          // cancelled on the stored line.
          new_ceiling:
            line.next_qty -
            Number(oldById.get(line.line_id)?.qty_cancelled ?? 0),
          deleted: line.next_qty === 0 && !keepIds.has(line.line_id),
        }))
      );
      if (trackingRejections.length > 0) {
        return res.status(409).json({
          error:
            "Some lines are already on an inbound shipment and cannot be reduced.",
          code: "line_claimed_by_tracking",
          rejections: trackingRejections,
        });
      }
    }

    if (reductions.length > 0) {
      const knex = req.scope.resolve("__pg_connection__") as {
        raw: (
          sql: string,
          bindings?: unknown[]
        ) => Promise<{ rows: unknown[]; rowCount?: number }>;
      };
      // TWO counts, because warning and blocking are different questions
      // (2026-08-04):
      //   billed_qty        — every active bill, drafts included. Drives the
      //                       confirmation modal, so the operator is still told
      //                       that a bill claims these units.
      //   posted_billed_qty — confirmed/synced only. Drives the BLOCK.
      //
      // A draft bill routinely claims units the PO has not received and may
      // never receive: the vendor invoices before the goods ship, which is the
      // normal partial-delivery flow. Blocking a PO correction on a draft froze
      // the PO behind an invoice that was simply entered early — and the real
      // cap already lives downstream, where it matters:
      // `resolveRemainingPoQuantities` caps a bill's quantities against the
      // PO's ordered qty at the bill's own Save, and Confirm revalidates. So a
      // draft left over-claiming after a PO reduction is caught where money is
      // posted, and reported as drift in the meantime.
      const billingResult = await knex.raw(
        `SELECT vbl.purchase_order_line_id,
                COALESCE(SUM(vbl.qty), 0)::int AS billed_qty,
                COALESCE(
                  SUM(vbl.qty) FILTER (
                    WHERE vb.status IN ('confirmed', 'synced')
                  ), 0
                )::int AS posted_billed_qty,
                -- Whether a Bill that LIVES IN QUICKBOOKS carries this line is
                -- what decides whether the PO Mod is about to be refused with
                -- error 3060 — QuickBooks validates against its own copy, not
                -- ours, and a local draft's edits have not reached it.
                BOOL_OR(vb.qb_txn_id IS NOT NULL) AS has_qb_bill,
                COALESCE(
                  (ARRAY_AGG(vb.number ORDER BY vb.number)
                     FILTER (WHERE vb.qb_txn_id IS NOT NULL))[1],
                  NULL
                ) AS qb_bill_number,
                BOOL_OR(vb.qb_source = 'adopted') AS has_adopted_bill,
                jsonb_agg(DISTINCT jsonb_build_object(
                  'id', vb.id,
                  'number', vb.number,
                  'status', vb.status,
                  'qb_source', vb.qb_source
                )) AS bills
           FROM vendor_bill vb
           JOIN vendor_bill_line vbl
             ON vbl.vendor_bill_id = vb.id
            AND vbl.deleted_at IS NULL
            AND COALESCE(vbl.line_type, 'product') = 'product'
          WHERE vb.purchase_order_id = ?
            AND vb.bill_type = 'regular'
            AND vb.status IN ('draft', 'confirmed', 'synced')
            AND vb.deleted_at IS NULL
            AND vbl.purchase_order_line_id = ANY(?)
          GROUP BY vbl.purchase_order_line_id`,
        [id, reductions.map((line) => line.line_id)]
      );
      const billingByLine = new Map(
        (
          billingResult.rows as Array<{
            purchase_order_line_id: string;
            billed_qty: number | string;
            posted_billed_qty: number | string;
            has_qb_bill: boolean;
            qb_bill_number: string | null;
            has_adopted_bill: boolean;
            bills: unknown;
          }>
        ).map((row) => [
          row.purchase_order_line_id,
          {
            billed_qty: Number(row.billed_qty ?? 0),
            posted_billed_qty: Number(row.posted_billed_qty ?? 0),
            has_qb_bill: Boolean(row.has_qb_bill),
            qb_bill_number: row.qb_bill_number,
            has_adopted_bill: Boolean(row.has_adopted_bill),
            bills: row.bills,
          },
        ])
      );

      // Lines being reduced that a QuickBooks-resident Bill still claims. The
      // PO Mod for these WILL be refused with error 3060 — QuickBooks compares
      // against its own copy of the Bill, and a local draft's edits have not
      // reached it. Enqueuing anyway produces a red pipeline row hours later
      // that tells the operator nothing actionable, so the enqueue is skipped
      // and the response says a repair is required instead. (2026-08-04)
      for (const line of reductions) {
        const billing = billingByLine.get(line.line_id);
        if (billing?.has_qb_bill) {
          qbRepairRequired.push({
            po_line_id: line.line_id,
            sku: line.sku,
            previous_qty: line.previous_qty,
            next_qty: line.next_qty,
            vendor_bill_number: billing.qb_bill_number,
          });
        }
      }

      const adoptedHeaderOnly = await knex.raw(
        `SELECT vb.id, vb.number
           FROM vendor_bill vb
          WHERE vb.purchase_order_id = ?
            AND vb.bill_type = 'regular'
            AND vb.qb_source = 'adopted'
            AND vb.status IN ('confirmed', 'synced')
            AND vb.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM vendor_bill_line vbl
               WHERE vbl.vendor_bill_id = vb.id
                 AND vbl.deleted_at IS NULL
            )
          LIMIT 1`,
        [id]
      );
      if (adoptedHeaderOnly.rows.length > 0) {
        return res.status(409).json({
          error:
            "This PO has an adopted QuickBooks Bill without line quantities. " +
            "Its billed floor cannot be verified automatically.",
          code: "adopted_bill_qty_unknown",
          bill: adoptedHeaderOnly.rows[0],
        });
      }

      const affected = reductions
        .map((line) => ({
          ...line,
          ...(billingByLine.get(line.line_id) ?? {
            billed_qty: 0,
            posted_billed_qty: 0,
            has_adopted_bill: false,
            bills: [],
          }),
        }))
        .filter((line) => line.billed_qty > 0);

      // Only POSTED quantities are a floor. Money has moved for those: they are
      // in QuickBooks and they moved AVCO, so dropping the PO under them would
      // leave a Bill in QB with no PO to back it.
      const belowBilled = affected.filter(
        (line) => line.next_qty < line.posted_billed_qty
      );
      if (belowBilled.length > 0) {
        return res.status(409).json({
          error:
            "Reduce the linked Vendor Bill first, reconfirm it, then retry this PO reduction.",
          code: "po_qty_below_billed",
          lines: belowBilled,
        });
      }

      // [REMOVED 2026-08-04] `vendor_bill_revision_pending` rejected the
      // reduction whenever a linked bill sat in draft, demanding its BillMod be
      // confirmed first. It blocked corrections that broke nothing: PO-1110's
      // ECTSK-RFRC1C5A went 50 → 20 with 20 received and 20 billed on a DRAFT
      // bill — 20 ≤ 20 ≤ 20, the invariant held exactly — and the save was
      // refused anyway. A draft is the document still being fitted to the PO,
      // not a fact the PO has to respect.

      if (affected.length > 0 && body.confirm_billed_reduction !== true) {
        return res.status(409).json({
          error:
            "This reduction affects quantities already billed in QuickBooks and requires confirmation.",
          code: "billed_reduction_confirmation_required",
          lines: affected,
        });
      }
    }

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
    // Capture the created rows: the mirror below needs their generated ids to
    // stamp inventory_transfer_line.purchase_order_line_id.
    const insertedLines: Array<{ id: string }> =
      toInsert.length > 0
        ? ((await service.createPurchaseOrderLines(toInsert)) as Array<{
            id: string;
          }>)
        : [];

    // Mirror line changes onto the linked inventory_transfer so China
    // reservations stay in sync. The IT holds the China-side reservation_items;
    // a PO line change that doesn't reach the IT leaves reservations wrong:
    //   - deleting a PO line → orphan China reservation (over-reserved)
    //   - adding a PO line   → NO China reservation for those units (phantom
    //                          inventory: the PO "orders" units from China that
    //                          were never reserved there). This is exactly what
    //                          convert-to-transfer exists to prevent.
    // Lines are matched by purchase_order_line_id — product_variant_id is NOT
    // unique within a PO (the Sample-Product placeholder repeats), and matching
    // by variant collapsed sibling lines into one IT line (IT-1045/IT-1036).
    // Variant matching survives only as a fallback for legacy rows the
    // migration backfill could not disambiguate. After reconciling lines we
    // recompute the IT header totals and rebuild reservations.
    const mirrorUpdates = toUpdate.filter((u) => {
      const old = oldById.get(u.id);
      if (!old) return false;
      return (
        Number(old.qty_ordered) !== Number(u.data.qty_ordered) ||
        Number(old.unit_cost_cents) !== Number(u.data.unit_cost_cents) ||
        String(old.sku_snapshot ?? "") !== String(u.data.sku_snapshot ?? "") ||
        String(old.description_snapshot ?? "") !==
          String(u.data.description_snapshot ?? "")
      );
    });
    if (
      toDelete.length > 0 ||
      mirrorUpdates.length > 0 ||
      insertedLines.length > 0
    ) {
      try {
        const knex = (req.scope as any).resolve("__pg_connection__") as {
          raw: (
            sql: string,
            bindings?: unknown[]
          ) => Promise<{ rows: unknown[]; rowCount?: number }>;
        };
        // Only mirror onto a transfer whose stock story is still open. A
        // 'received' IT is a historical fact (its units already moved
        // China→USA) and a 'voided' one is dead — editing either rewrites
        // history. Note the status filter also keeps LIMIT 1 from picking a
        // voided IT over the live replacement convert-to-transfer allows.
        const transferResult = await knex.raw(
          `SELECT id FROM inventory_transfer
            WHERE linked_purchase_order_id = ?
              AND status IN ('draft', 'confirmed', 'shipped')
              AND deleted_at IS NULL
            LIMIT 1`,
          [id]
        );
        const linkedTransfer = transferResult.rows[0] as { id: string } | undefined;

        if (linkedTransfer) {
          const transferId = linkedTransfer.id;

          // FK first; fall back to an unclaimed (NULL-FK) legacy row of the
          // same variant. Never match a row already claimed by a sibling line.
          const findItLine = async (
            poLineId: string,
            variantId: string
          ): Promise<{ id: string } | undefined> => {
            const byFk = await knex.raw(
              `SELECT id FROM inventory_transfer_line
                WHERE transfer_id = ? AND purchase_order_line_id = ?
                  AND deleted_at IS NULL
                LIMIT 1`,
              [transferId, poLineId]
            );
            if (byFk.rows[0]) return byFk.rows[0] as { id: string };
            const legacy = await knex.raw(
              `SELECT id FROM inventory_transfer_line
                WHERE transfer_id = ? AND product_variant_id = ?
                  AND purchase_order_line_id IS NULL
                  AND deleted_at IS NULL
                LIMIT 1`,
              [transferId, variantId]
            );
            return legacy.rows[0] as { id: string } | undefined;
          };

          for (const oldLine of oldLines.filter((l) => toDelete.includes(l.id))) {
            const itLine = await findItLine(
              oldLine.id,
              String(oldLine.product_variant_id)
            );
            if (!itLine) continue;
            await knex.raw(
              `UPDATE inventory_transfer_line
                  SET deleted_at = NOW(), updated_at = NOW()
                WHERE id = ? AND deleted_at IS NULL`,
              [itLine.id]
            );
          }

          for (const upd of mirrorUpdates) {
            const itLine = await findItLine(
              upd.id,
              String(upd.data.product_variant_id)
            );
            if (!itLine) continue;
            // Claiming the row (setting the FK) heals legacy lines in place.
            await knex.raw(
              `UPDATE inventory_transfer_line
                  SET qty = ?, unit_cost_cents = ?, sku = ?, description = ?,
                      purchase_order_line_id = ?, updated_at = NOW()
                WHERE id = ? AND deleted_at IS NULL`,
              [
                Number(upd.data.qty_ordered ?? 0),
                Number(upd.data.unit_cost_cents ?? 0),
                String(upd.data.sku_snapshot ?? ""),
                String(upd.data.description_snapshot ?? ""),
                upd.id,
                itLine.id,
              ]
            );
          }

          // New PO lines always insert a fresh IT line carrying the FK. No
          // variant-based adoption here: a live NULL-FK row of the same
          // variant belongs to some OTHER legacy PO line, and adopting it is
          // exactly the collapse this fix removes. (The old soft-delete
          // revive existed only to dodge duplicate variant rows, which are
          // legal now that identity is per line.)
          for (let i = 0; i < insertedLines.length; i++) {
            const ins = toInsert[i];
            const created = insertedLines[i];
            if (!ins || !created) continue;
            await knex.raw(
              `INSERT INTO inventory_transfer_line (
                  id, transfer_id, purchase_order_line_id, product_variant_id,
                  sku, description, qty, unit_cost_cents, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
              [
                generateEntityId("", "itl"),
                transferId,
                created.id,
                ins.product_variant_id as string,
                (ins.sku_snapshot as string) ?? "",
                (ins.description_snapshot as string) ?? "",
                Number(ins.qty_ordered ?? 0),
                Number(ins.unit_cost_cents ?? 0),
              ]
            );
          }

          // Recompute IT header totals from the live (non-deleted) lines so the
          // transfer summary matches its lines after any add/remove/qty change.
          await knex.raw(
            `UPDATE inventory_transfer AS it
                SET total_lines = agg.c,
                    total_units = agg.u,
                    subtotal_cents = agg.s,
                    updated_at = NOW()
               FROM (
                 SELECT COUNT(*) AS c,
                        COALESCE(SUM(qty), 0) AS u,
                        COALESCE(SUM(qty * unit_cost_cents), 0) AS s
                   FROM inventory_transfer_line
                  WHERE transfer_id = ? AND deleted_at IS NULL
               ) AS agg
              WHERE it.id = ?`,
            [transferId, transferId]
          );

          const touchedInventoryItemIds =
            await rebuildTransferChinaReservations(knex, transferId, id);

          // Instant MeiliSearch parity for the touched items. The PG triggers
          // on inventory_level/reservation_item already guarantee eventual sync
          // (~1min), but the sibling IT→PO handler syncs inline for immediacy;
          // mirror that here so the inventory page reflects the change at once.
          await Promise.allSettled(
            touchedInventoryItemIds.map((inventoryItemId) =>
              syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
                input: { inventoryItemId },
              })
            )
          );
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

    // Recompute header receive status. Editing lines never changes
    // total_units_received (received lines can't be deleted and qty_ordered
    // can't drop below qty_received — see per-item guard above), but reducing
    // qty_ordered can make a partially_received PO become fully received.
    // Without this, a PO edited down to its received count stays stuck in
    // 'partially_received' / "open" forever. Mirrors persist-receipt-step.ts.
    const RECEIVE_LIFECYCLE = ["submitted", "partially_received", "received"];
    const totalReceived = Number(
      (existing as { total_units_received?: number }).total_units_received ?? 0
    );
    if (RECEIVE_LIFECYCLE.includes(existing.status)) {
      if (totalReceived > 0) {
        headerUpdate.status =
          totalReceived >= totals.total_units_ordered
            ? "received"
            : "partially_received";
      }
    }

    // Re-derive the display `po_status` from receiving progress after the line
    // change (e.g. adding a new line to a "Fully Received" PO drops it to
    // "Partial Rcvd Pending Partial"). Skipped when the caller is explicitly
    // setting po_status in this same request — a manual pick always wins.
    if (bodyPoStatus === undefined) {
      const effectiveLifecycle =
        (headerUpdate.status as string | undefined) ?? existing.status;
      // "Does this PO have a shipment?" is now a table read. `existing.tracking`
      // is the frozen JSON column and would answer for a world that stopped
      // being written — a PO whose only tracking was added after the cutover
      // would silently reconcile to "Missing Tracking".
      const trackingCountDb = req.scope.resolve("__pg_connection__") as {
        raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
      };
      const liveTracking = await resolvePoShipments(trackingCountDb, id);
      const reconciledPoStatus = reconcileReceivedPoStatus(
        existing.po_status ?? null,
        effectiveLifecycle,
        totals.total_units_ordered,
        totalReceived,
        poHasTracking(liveTracking)
      );
      if (reconciledPoStatus !== null) {
        headerUpdate.po_status = reconciledPoStatus;
      }
    }
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
  // `received` is included so a line added to a fully-received (but QB-synced)
  // PO still propagates to QuickBooks as a PurchaseOrderMod. QB accepts the new
  // line on an already-received PO and simply reopens its received state.
  const EDITABLE_SYNCED_STATUSES = [
    "submitted",
    "partially_received",
    "received",
  ];
  if (
    EDITABLE_SYNCED_STATUSES.includes(existing.status) &&
    existing.qb_purchase_order_list_id &&
    requiresQbMod &&
    // A PO Mod that reduces a line a QuickBooks-resident Bill still claims is
    // refused by QuickBooks (3060). It is NOT enqueued: the operator gets
    // `qb_repair_required` on this response and the repair sequence deletes
    // the Bill first. The local PO is already saved and correct either way.
    qbRepairRequired.length === 0
  ) {
    let delegatedPipelineRowIsDurable = false;
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
        delegated_to_consolidator: true,
        operation_revision: randomUUID(),
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
      const updatedPipeline = await knex.raw(
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
      let legacyPipelineId = String(
        (
          await knex.raw(
            `SELECT id
               FROM qb_purchase_order_pipeline
              WHERE purchase_order_id = ? AND deleted_at IS NULL
              LIMIT 1`,
            [id]
          )
        ).rows[0]?.id ?? ""
      );
      if ((updatedPipeline.rowCount ?? 0) === 0) {
        const createdPipeline = await service.createQbPurchaseOrderPipelines([
          { purchase_order_id: id, status: "waiting", payload: modPayload },
        ]);
        const createdRows = Array.isArray(createdPipeline)
          ? createdPipeline
          : [createdPipeline];
        legacyPipelineId = String(
          (createdRows[0] as { id: string } | undefined)?.id ?? ""
        );
      }
      if (!legacyPipelineId) {
        throw new Error("Purchase Order pipeline row was not created");
      }
      // From this point the consolidator repair pass can recreate the universal
      // dependency row after any narrow crash/error below.
      delegatedPipelineRowIsDurable = true;

      const orderPayload = {
        ...modPayload,
        qb_purchase_order_pipeline_id: legacyPipelineId,
      };
      const operation = await enqueuePurchaseQbOperation(knex, {
        purchaseOrderId: id,
        referenceId: id,
        referenceType: "purchase_order",
        step: "purchase_order_mod",
        qbTxnId: existing.qb_purchase_order_list_id,
        payload: orderPayload,
        operationKey: purchaseOperationKey(
          "purchase_order_mod",
          id,
          orderPayload
        ),
      });
      await knex.raw(
        `UPDATE qb_purchase_order_pipeline
            SET order_pipeline_id = ?, updated_at = NOW()
          WHERE id = ?`,
        [operation.id, legacyPipelineId]
      );
    } catch (qbErr) {
      console.error("[po-patch] Failed to enqueue QB MOD:", qbErr);
      if (!delegatedPipelineRowIsDurable) {
        return res.status(503).json({
          error:
            "The PO was saved locally, but its QuickBooks update could not be queued. Retry Save before continuing with receipts or bills.",
          code: "qb_purchase_mod_enqueue_failed",
          local_save_succeeded: true,
          purchase_order: updated,
        });
      }
      // The operator-facing row is durable and marked as delegated, so the
      // repair pass will attach it to the PO dependency chain. The legacy
      // poller cannot dispatch it out of order.
    }
  }

  // The PO itself saved. `qb_repair_required` says QuickBooks could NOT be
  // updated yet because a Bill living there still claims the reduced units —
  // the POS turns this into the "update and confirm the Vendor Bill" prompt.
  // Absent/empty means nothing is pending, never "unknown".
  return res.json({
    purchase_order: updated,
    qb_repair_required:
      qbRepairRequired.length > 0 ? qbRepairRequired : undefined,
  });
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
