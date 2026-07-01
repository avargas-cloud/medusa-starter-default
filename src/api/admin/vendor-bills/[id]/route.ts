/**
 * src/api/admin/vendor-bills/[id]/route.ts
 *
 * GET    /admin/vendor-bills/:id
 *   Returns the full vendor bill detail with all lines plus PO / receipt
 *   display fields: po_number, receipt_number, vendor_name, receipt.received_at.
 *
 * DELETE /admin/vendor-bills/:id
 *   Hard-deletes a DRAFT vendor bill (and its lines via cascade). Confirmed
 *   bills cannot be deleted because they have already mutated
 *   product_variant.metadata.avg_landed_cost_cents.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { randomUUID } from "crypto";

import { getActorUserId, UnauthenticatedError } from "../../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../../purchase-orders/_lib/format";
import { recomputeBillFinanceLinks } from "../../../../lib/finance/recompute-bill-finance";

// ── Knex type ────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    KnexInstance & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

interface VendorBillDetailRow {
  id: string;
  number: string | null;
  purchase_order_id: string | null;
  purchase_order_receipt_id: string | null;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  bill_type: string;
  status: string;
  reference_id: string | null;
  document_date: string | null;
  commission_mode: string;
  commission_rate_bps: number;
  commission_amount_cents: number;
  commission_invoice_number: string | null;
  service_vendor_bill_id: string | null;
  freight_included: boolean;
  freight_amount_cents: number;
  freight_invoice_number: string | null;
  freight_vendor_bill_id: string | null;
  tariff_included: boolean;
  tariff_amount_cents: number;
  tariff_number: string | null;
  tariff_vendor_bill_id: string | null;
  notes: string | null;
  confirmed_at: string | null;
  confirmed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  po_number: string | null;
  po_status: string | null;
  po_qb_ref_number: string | null;
  receipt_number: string | null;
  vendor_name: string | null;
  receipt_received_at: string | null;
  ship_to_location_name: string | null;
}

interface VendorBillLineRow {
  id: string;
  vendor_bill_id: string;
  receipt_line_id: string;
  line_type: string;
  qb_account_list_id: string | null;
  qb_account_full_name: string | null;
  qb_account_type: string | null;
  product_variant_id: string | null;
  sku: string;
  mpn: string | null;
  description: string;
  qty: number;
  unit_cost_cents: number;
  cbm_per_unit: number | null;
  commission_per_unit_cents: number;
  freight_per_unit_cents: number;
  tariff_per_unit_cents: number;
  landed_unit_cost_cents: number;
}

const vendorBillPatchSchema = z.object({
  vendor_id: z.string().min(1).nullish(),
  bill_type: z.enum(["regular", "service", "freight", "tariff"]).optional(),
  reference_id: z.string().max(200).nullish(),
  document_date: z.string().datetime().nullish(),
  commission_mode: z.enum(["percent", "fixed"]).optional(),
  commission_rate_bps: z.number().int().min(0).max(100_000).optional(),
  commission_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  commission_invoice_number: z.string().max(200).nullish(),
  service_vendor_bill_id: z.string().max(200).nullish(),
  freight_included: z.boolean().optional(),
  freight_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  freight_invoice_number: z.string().max(200).nullish(),
  freight_vendor_bill_id: z.string().max(200).nullish(),
  tariff_included: z.boolean().optional(),
  tariff_amount_cents: z.number().int().min(0).max(1_000_000_000).optional(),
  tariff_number: z.string().max(200).nullish(),
  tariff_vendor_bill_id: z.string().max(200).nullish(),
  notes: z.string().max(2000).nullish(),
  clear_lines_for_type_change: z.boolean().optional(),
  // Staged line edits, persisted together with the header in a SINGLE request
  // (no per-keystroke auto-save). Draft regular bills only.
  line_quantities: z
    .array(
      z.object({
        id: z.string().min(1),
        qty: z.number().int().min(0).max(1_000_000),
      })
    )
    .optional(),
  removed_line_ids: z.array(z.string().min(1)).optional(),
  // Full desired product-line set for a staged save (browser-side editing:
  // qty edits, removals, and Update-From results all resolve to this set).
  // Lines with an `id` update in place; without an `id` they are inserted;
  // existing product lines absent from the set are removed.
  lines: z
    .array(
      z.object({
        id: z.string().optional(),
        purchase_order_line_id: z.string().min(1),
        qty: z.number().int().min(0).max(1_000_000),
        unit_cost_cents: z.number().int().min(0).max(1_000_000_000),
        sku: z.string().max(200),
        description: z.string().max(1000),
        cbm_per_unit: z.number().nullable().optional(),
        mpn: z.string().max(200).nullable().optional(),
        product_variant_id: z.string().nullable().optional(),
      })
    )
    .optional(),
  // Staged receipt pin (Update-From-Receipt); null clears the pin.
  purchase_order_receipt_id: z.string().nullable().optional(),
});

const LINKED_BILL_TYPE_BY_FIELD: Record<string, string> = {
  service_vendor_bill_id: "service",
  freight_vendor_bill_id: "freight",
  tariff_vendor_bill_id: "tariff",
};

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const headerResult = await knex.raw(
    `SELECT
       vb.id,
       vb.number,
       vb.purchase_order_id,
       COALESCE(vb.purchase_order_receipt_id, fallback_por.id) AS purchase_order_receipt_id,
       vb.vendor_id,
       vb.vendor_name_snapshot,
       vb.vendor_qb_list_id_snapshot,
       vb.bill_type,
       vb.status,
       vb.reference_id,
       vb.document_date,
       vb.commission_mode,
       vb.commission_rate_bps,
       vb.commission_amount_cents,
       vb.commission_invoice_number,
       vb.service_vendor_bill_id,
       vb.freight_included,
       vb.freight_amount_cents,
       vb.freight_invoice_number,
       vb.freight_vendor_bill_id,
       vb.tariff_included,
       vb.tariff_amount_cents,
       vb.tariff_number,
       vb.tariff_vendor_bill_id,
       vb.notes,
       vb.confirmed_at,
       vb.confirmed_by_user_id,
       vb.created_at,
       vb.updated_at,
       po."number"                         AS po_number,
       po.status                           AS po_status,
       po.qb_purchase_order_txn_number      AS po_qb_ref_number,
       COALESCE(por."number", fallback_por."number") AS receipt_number,
       COALESCE(vb.vendor_name_snapshot, po.vendor_name_snapshot) AS vendor_name,
       COALESCE(por.received_at, fallback_por.received_at) AS receipt_received_at,
       sl.name                             AS ship_to_location_name
     FROM vendor_bill vb
     LEFT JOIN purchase_order po
       ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
     LEFT JOIN purchase_order_receipt por
       ON por.id = vb.purchase_order_receipt_id AND por.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT id, "number", received_at, stock_location_id
       FROM purchase_order_receipt
       WHERE purchase_order_id = po.id
         AND po.status = 'received'
         AND status IN ('applied', 'synced')
         AND deleted_at IS NULL
       ORDER BY received_at ASC
       LIMIT 1
     ) fallback_por ON vb.purchase_order_receipt_id IS NULL
     LEFT JOIN stock_location sl
       ON sl.id = COALESCE(por.stock_location_id, fallback_por.stock_location_id) AND sl.deleted_at IS NULL
     WHERE vb.id = ? AND vb.deleted_at IS NULL`,
    [id]
  );

  const header = (headerResult.rows[0] ?? null) as VendorBillDetailRow | null;
  if (!header) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  const linesResult = await knex.raw(
    `SELECT
       id,
       vendor_bill_id,
       receipt_line_id,
       purchase_order_line_id,
       line_type,
       qb_account_list_id,
       qb_account_full_name,
       qb_account_type,
       product_variant_id,
       sku,
       mpn,
       description,
       qty,
       unit_cost_cents,
       cbm_per_unit,
       commission_per_unit_cents,
       freight_per_unit_cents,
       tariff_per_unit_cents,
       landed_unit_cost_cents
     FROM vendor_bill_line
     WHERE vendor_bill_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [id]
  );

  const lines = linesResult.rows as VendorBillLineRow[];

  const total_landed_cents = lines.reduce(
    (s, l) => s + l.landed_unit_cost_cents * l.qty,
    0
  );

  return res.json({ vendor_bill: { ...header, total_landed_cents, lines } });
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
  const parsed = vendorBillPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const patch = parsed.data;
  const knex = resolveKnex(req);

  const lookup = await knex.raw(
    `SELECT id, status, bill_type, purchase_order_id, purchase_order_receipt_id FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (lookup.rows[0] ?? null) as
    | { id: string; status: string; bill_type: string; purchase_order_id: string | null; purchase_order_receipt_id: string | null }
    | null;
  if (!bill) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (bill.status !== "draft" && bill.status !== "confirmed") {
    return res.status(409).json({
      error: `Cannot update a vendor bill in status '${bill.status}'. Only draft or confirmed bills can be edited.`,
      code: "not_draft",
    });
  }

  if (patch.vendor_id !== undefined && patch.vendor_id !== null) {
    const vendorResult = await knex.raw(
      `SELECT id, qb_list_id, full_name, name, company_name
       FROM qb_vendor
       WHERE id = ? AND deleted_at IS NULL AND is_active = true
       LIMIT 1`,
      [patch.vendor_id]
    );
    const vendor = (vendorResult.rows[0] ?? null) as
      | {
          id: string;
          qb_list_id: string | null;
          full_name: string | null;
          name: string | null;
          company_name: string | null;
        }
      | null;
    if (!vendor) {
      return res.status(422).json({
        error: "A valid active vendor must be selected",
        code: "vendor_required",
      });
    }
    patch.vendor_id = vendor.id;
    (patch as typeof patch & { vendor_name_snapshot?: string }).vendor_name_snapshot =
      vendor.company_name ?? vendor.full_name ?? vendor.name ?? vendor.id;
    (patch as typeof patch & { vendor_qb_list_id_snapshot?: string | null }).vendor_qb_list_id_snapshot =
      vendor.qb_list_id;
  }

  if (patch.bill_type && patch.bill_type !== bill.bill_type) {
    const linesResult = await knex.raw(
      `SELECT COUNT(*) AS count FROM vendor_bill_line WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
      [id]
    );
    const lineCount = Number((linesResult.rows[0] as { count: string }).count);
    if (lineCount > 0 && !patch.clear_lines_for_type_change) {
      return res.status(409).json({
        error:
          "Changing bill type will remove all existing lines. Confirm clear_lines_for_type_change to continue.",
        code: "type_change_requires_clear",
        line_count: lineCount,
      });
    }
    if (lineCount > 0) {
      await knex.raw(
        `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
         WHERE vendor_bill_id = ? AND deleted_at IS NULL`,
        [id]
      );
    }
  }

  const effectiveBillType = patch.bill_type ?? bill.bill_type;
  if (effectiveBillType !== "regular") {
    patch.commission_rate_bps = 0;
    patch.commission_amount_cents = 0;
    patch.commission_invoice_number = null;
    patch.service_vendor_bill_id = null;
    patch.freight_included = false;
    patch.freight_amount_cents = 0;
    patch.freight_invoice_number = null;
    patch.freight_vendor_bill_id = null;
    patch.tariff_included = false;
    patch.tariff_amount_cents = 0;
    patch.tariff_number = null;
    patch.tariff_vendor_bill_id = null;
  }

  for (const [field, requiredType] of Object.entries(LINKED_BILL_TYPE_BY_FIELD)) {
    const linkedId = patch[field as keyof typeof patch];
    if (linkedId === undefined || linkedId === null || linkedId === "") continue;
    if (linkedId === id) {
      return res.status(422).json({
        error: "A vendor bill cannot be linked to itself",
        code: "self_link",
      });
    }
    const linkedResult = await knex.raw(
      `SELECT id, status, bill_type
       FROM vendor_bill
       WHERE id = ? AND deleted_at IS NULL`,
      [linkedId]
    );
    const linked = (linkedResult.rows[0] ?? null) as
      | { id: string; status: string; bill_type: string }
      | null;
    if (!linked) {
      return res.status(404).json({
        error: `Linked ${requiredType} bill not found`,
        code: "linked_bill_not_found",
      });
    }
    if (linked.bill_type !== requiredType) {
      return res.status(422).json({
        error: `Linked bill must be a ${requiredType} bill`,
        code: "linked_bill_wrong_type",
      });
    }
    if (linked.status !== "draft" && linked.status !== "confirmed") {
      return res.status(422).json({
        error: `Linked ${requiredType} bill must be draft or confirmed`,
        code: "linked_bill_not_open",
      });
    }
  }

  const updatePayload: Record<string, unknown> = {};
  for (const key of [
    "vendor_id",
    "vendor_name_snapshot",
    "vendor_qb_list_id_snapshot",
    "bill_type",
    "reference_id",
    "document_date",
    "commission_mode",
    "commission_rate_bps",
    "commission_amount_cents",
    "commission_invoice_number",
    "service_vendor_bill_id",
    "freight_included",
    "freight_amount_cents",
    "freight_invoice_number",
    "freight_vendor_bill_id",
    "tariff_included",
    "tariff_amount_cents",
    "tariff_number",
    "tariff_vendor_bill_id",
    "notes",
  ]) {
    if (key in patch) {
      updatePayload[key] = patch[key as keyof typeof patch] ?? null;
    }
  }

  // ── Validate staged line edits before any write ─────────────────────────────
  const fullLines = patch.lines;
  const hasFullLines = fullLines !== undefined;
  const qtyEdits = hasFullLines ? [] : patch.line_quantities ?? [];
  const removedIds = hasFullLines ? [] : patch.removed_line_ids ?? [];
  const pinProvided = "purchase_order_receipt_id" in patch;
  const hasLineEdits = hasFullLines || qtyEdits.length > 0 || removedIds.length > 0;

  // Shared PO-line map (caps + new-line snapshots) for the bill's PO.
  const poLineById = new Map<
    string,
    { po_qty: number; product_variant_id: string; sku: string; description: string; metadata: Record<string, unknown> | null }
  >();

  if (hasLineEdits || pinProvided) {
    if (bill.status !== "draft" || effectiveBillType !== "regular") {
      return res.status(409).json({ error: "Lines can only be edited on draft regular bills", code: "not_draft" });
    }
    if (!bill.purchase_order_id) {
      return res.status(422).json({ error: "This bill is not linked to a purchase order", code: "no_purchase_order" });
    }
    const confirmedWire = await knex.raw(
      `SELECT 1 FROM china_finance_bill cfb
         JOIN china_wire_transfer_application cwta ON cwta.bill_id = cfb.id
         JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
        WHERE cfb.vendor_bill_id = ? AND cwt.status = 'confirmed' LIMIT 1`,
      [id]
    );
    if (confirmedWire.rows.length > 0) {
      return res.status(409).json({ error: "This bill is paid by a confirmed wire and can't be edited", code: "on_confirmed_wire" });
    }

    const polRows = await knex.raw(
      `SELECT pol.id, GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0)::int AS po_qty,
              pol.product_variant_id, pol.sku_snapshot, pol.description_snapshot, pv.metadata
         FROM purchase_order_line pol
         LEFT JOIN product_variant pv ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
        WHERE pol.purchase_order_id = ? AND pol.deleted_at IS NULL`,
      [bill.purchase_order_id]
    );
    for (const r of polRows.rows as Array<Record<string, unknown>>) {
      poLineById.set(r.id as string, {
        po_qty: Number(r.po_qty ?? 0),
        product_variant_id: r.product_variant_id as string,
        sku: (r.sku_snapshot as string) ?? "",
        description: (r.description_snapshot as string) ?? "",
        metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      });
    }
  }

  // Staged receipt pin validation.
  if (pinProvided && patch.purchase_order_receipt_id) {
    const rid = patch.purchase_order_receipt_id;
    const rr = await knex.raw(
      `SELECT purchase_order_id, status FROM purchase_order_receipt WHERE id = ? AND deleted_at IS NULL`,
      [rid]
    );
    const rrow = rr.rows[0] as { purchase_order_id: string; status: string } | undefined;
    if (!rrow || rrow.purchase_order_id !== bill.purchase_order_id) {
      return res.status(422).json({ error: "Receipt does not belong to this bill's purchase order", code: "receipt_po_mismatch" });
    }
    if (rrow.status !== "applied" && rrow.status !== "synced") {
      return res.status(422).json({ error: "Receipt is not applied yet", code: "receipt_not_applied" });
    }
    const pinnedElsewhere = await knex.raw(
      `SELECT id FROM vendor_bill WHERE purchase_order_receipt_id = ? AND id <> ? AND deleted_at IS NULL LIMIT 1`,
      [rid, id]
    );
    if (pinnedElsewhere.rows.length > 0) {
      return res.status(409).json({ error: "Another vendor bill is already pinned to this receipt", code: "receipt_already_pinned" });
    }
  }

  // Existing product lines on the bill (id → row).
  let existingProductLines: Array<{ id: string; purchase_order_line_id: string | null }> = [];
  if (hasLineEdits) {
    const plResult = await knex.raw(
      `SELECT id, purchase_order_line_id FROM vendor_bill_line
        WHERE vendor_bill_id = ? AND deleted_at IS NULL AND COALESCE(line_type,'product') = 'product'`,
      [id]
    );
    existingProductLines = plResult.rows as Array<{ id: string; purchase_order_line_id: string | null }>;
  }
  const existingById = new Map(existingProductLines.map((l) => [l.id, l]));

  if (hasFullLines) {
    if (!bill.purchase_order_receipt_id && !pinProvided) {
      // Not pinned and staying unpinned — fine (PO-sourced planning bill).
    }
    if (fullLines!.length < 1) {
      return res.status(422).json({ error: "Vendor bill must keep at least one line", code: "last_line" });
    }
    for (const l of fullLines!) {
      const pol = poLineById.get(l.purchase_order_line_id);
      if (!pol) return res.status(422).json({ error: `Line references a PO line not on this bill's purchase order`, code: "bad_po_line", purchase_order_line_id: l.purchase_order_line_id });
      if (l.qty > pol.po_qty) {
        return res.status(422).json({ error: `Max is the PO quantity (${pol.po_qty}) for ${l.sku}. Edit the PO to add more.`, code: "qty_exceeds_po", po_qty: pol.po_qty });
      }
      if (l.id && !existingById.has(l.id)) {
        return res.status(404).json({ error: `Line ${l.id} not found on this bill`, code: "line_not_found" });
      }
    }
  } else if (hasLineEdits) {
    if (bill.purchase_order_receipt_id) {
      return res.status(409).json({ error: "This bill is pinned to a receipt. Use 'Update from Receipt' to change its lines.", code: "bill_receipt_pinned" });
    }
    for (const edit of qtyEdits) {
      const l = existingById.get(edit.id);
      if (!l) return res.status(404).json({ error: `Line ${edit.id} not found on this bill`, code: "line_not_found" });
      if (!l.purchase_order_line_id) return res.status(422).json({ error: "Cannot determine PO line for the quantity cap", code: "no_po_line", line_id: edit.id });
      const cap = poLineById.get(l.purchase_order_line_id)?.po_qty ?? 0;
      if (edit.qty > cap) {
        return res.status(422).json({ error: `Max is the PO quantity (${cap}). Edit the purchase order to add more.`, code: "qty_exceeds_po", po_qty: cap, line_id: edit.id });
      }
    }
    for (const rid of removedIds) {
      if (!existingById.has(rid)) return res.status(404).json({ error: `Line ${rid} not found on this bill`, code: "line_not_found" });
    }
    if (existingProductLines.length - new Set(removedIds).size < 1) {
      return res.status(422).json({ error: "Vendor bill must keep at least one line", code: "last_line" });
    }
  }

  // ── Apply header + staged line edits + recompute in ONE transaction ─────────
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    // Staged receipt pin (Update-From-Receipt) — write with the header set.
    if (pinProvided) {
      updatePayload.purchase_order_receipt_id = patch.purchase_order_receipt_id ?? null;
    }
    const entries = Object.entries(updatePayload);
    if (entries.length > 0) {
      const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
      const values = entries.map(([, value]) => value);
      await db.raw(
        `UPDATE vendor_bill SET ${assignments}, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [...values, id]
      );
    }

    if (hasFullLines) {
      const keepIds = new Set(fullLines!.filter((l) => l.id).map((l) => l.id as string));
      // Remove existing product lines absent from the set.
      const toRemove = existingProductLines.filter((l) => !keepIds.has(l.id)).map((l) => l.id);
      if (toRemove.length > 0) {
        await db.raw(
          `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = ANY(?) AND vendor_bill_id = ? AND deleted_at IS NULL`,
          [toRemove, id]
        );
      }
      for (const l of fullLines!) {
        const pol = poLineById.get(l.purchase_order_line_id)!;
        const cbm = l.cbm_per_unit ?? null;
        if (l.id) {
          await db.raw(
            `UPDATE vendor_bill_line
                SET qty = ?, unit_cost_cents = ?, cbm_per_unit = ?::float, mpn = ?,
                    commission_per_unit_cents = 0, freight_per_unit_cents = 0,
                    tariff_per_unit_cents = 0, landed_unit_cost_cents = 0, updated_at = NOW()
              WHERE id = ? AND vendor_bill_id = ? AND deleted_at IS NULL`,
            [l.qty, l.unit_cost_cents, cbm, l.mpn ?? null, l.id, id]
          );
        } else {
          // New line — derive identity fields authoritatively from the PO line.
          await db.raw(
            `INSERT INTO vendor_bill_line (
               id, vendor_bill_id, receipt_line_id, purchase_order_line_id, line_type,
               product_variant_id, sku, mpn, description, qty, unit_cost_cents, cbm_per_unit,
               commission_per_unit_cents, freight_per_unit_cents, tariff_per_unit_cents,
               landed_unit_cost_cents, created_at, updated_at)
             VALUES (?, ?, NULL, ?, 'product', ?, ?, ?, ?, ?, ?, ?::float, 0, 0, 0, 0, NOW(), NOW())`,
            [
              `vbl_${randomUUID().replace(/-/g, "")}`,
              id,
              l.purchase_order_line_id,
              pol.product_variant_id,
              pol.sku,
              l.mpn ?? (typeof pol.metadata?.mpn === "string" ? pol.metadata.mpn : null),
              pol.description,
              l.qty,
              l.unit_cost_cents,
              cbm,
            ]
          );
        }
      }
    } else {
      for (const edit of qtyEdits) {
        await db.raw(
          `UPDATE vendor_bill_line
              SET qty = ?, commission_per_unit_cents = 0, freight_per_unit_cents = 0,
                  tariff_per_unit_cents = 0, landed_unit_cost_cents = 0, updated_at = NOW()
            WHERE id = ? AND vendor_bill_id = ? AND deleted_at IS NULL`,
          [edit.qty, edit.id, id]
        );
      }
      if (removedIds.length > 0) {
        await db.raw(
          `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = ANY(?) AND vendor_bill_id = ? AND deleted_at IS NULL`,
          [removedIds, id]
        );
      }
    }

    if (hasLineEdits) {
      const recompute = await recomputeBillFinanceLinks(db, id);
      if (!recompute.ok) {
        if (trx) await trx.rollback();
        return res.status(409).json({ error: recompute.message, code: recompute.code, conflicts: recompute.conflicts });
      }
    }

    if (bill.bill_type === "regular" && bill.purchase_order_id) {
      const linkedIds = [
        patch.service_vendor_bill_id,
        patch.freight_vendor_bill_id,
        patch.tariff_vendor_bill_id,
      ].filter((linkedId): linkedId is string => typeof linkedId === "string" && linkedId.length > 0);

      if (linkedIds.length > 0) {
        await db.raw(
          `UPDATE vendor_bill
             SET purchase_order_id = ?, updated_at = NOW()
            WHERE id = ANY(?)
              AND deleted_at IS NULL
              AND bill_type IN ('service', 'freight', 'tariff')`,
          [bill.purchase_order_id, linkedIds]
        );
      }
    }

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  return GET(req, res);
}

// ── DELETE — hard delete, draft only ─────────────────────────────────────────

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const lookup = (await knex.raw(
    `SELECT id, status FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
    [id]
  )) as { rows: Array<{ id: string; status: string }> };

  const existing = lookup.rows[0] ?? null;
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Vendor bill not found", code: "not_found" });
  }

  if (existing.status !== "draft") {
    return res.status(409).json({
      error:
        "Only draft vendor bills can be deleted — confirmed bills have already affected variant landed-cost averages.",
      code: "not_draft",
    });
  }

  // Safe delete (Phase 4): china_finance_bill.vendor_bill_id has NO cascade, so a
  // naive DELETE hits a 23503 FK violation. Walk the finance links transactionally
  // with row locks: block if any application is on a CONFIRMED wire (real money),
  // otherwise shrink the affected SCHEDULED wires (delta-aware) and remove the
  // cfb rows (their applications cascade) before deleting the bill.
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  try {
    // Re-lock the bill inside the transaction and re-check draft.
    const locked = (await db.raw(
      `SELECT id, status FROM vendor_bill WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
      [id]
    )) as { rows: Array<{ id: string; status: string }> };
    if (!locked.rows[0]) {
      if (trx) await trx.rollback();
      return res.status(404).json({ error: "Vendor bill not found", code: "not_found" });
    }
    if (locked.rows[0].status !== "draft") {
      if (trx) await trx.rollback();
      return res.status(409).json({
        error: "Only draft vendor bills can be deleted",
        code: "not_draft",
      });
    }

    // Lock the cfb rows for this bill.
    const cfbRows = (await db.raw(
      `SELECT id FROM china_finance_bill
        WHERE vendor_bill_id = ? FOR UPDATE`,
      [id]
    )) as { rows: Array<{ id: string }> };
    const cfbIds = cfbRows.rows.map((r) => r.id);

    if (cfbIds.length > 0) {
      // Lock applications + their wires; capture status + applied_cents.
      const appRows = (await db.raw(
        `SELECT cwta.id AS application_id, cwta.applied_cents,
                cwta.wire_transfer_id, cwt.status AS wire_status
           FROM china_wire_transfer_application cwta
           JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
          WHERE cwta.bill_id = ANY(?)
          FOR UPDATE`,
        [cfbIds]
      )) as {
        rows: Array<{
          application_id: string;
          applied_cents: number;
          wire_transfer_id: string;
          wire_status: string;
        }>;
      };

      const onConfirmed = appRows.rows.filter((a) => a.wire_status === "confirmed");
      if (onConfirmed.length > 0) {
        if (trx) await trx.rollback();
        return res.status(409).json({
          error:
            "This bill is paid by a confirmed wire transfer. Reverse the payment before deleting.",
          code: "on_confirmed_wire",
        });
      }

      // Shrink each scheduled wire by the applications we're about to remove
      // (delta-aware; preserves any surplus). Applications cascade-delete with cfb.
      const shrinkByWire = new Map<string, number>();
      for (const a of appRows.rows) {
        shrinkByWire.set(
          a.wire_transfer_id,
          (shrinkByWire.get(a.wire_transfer_id) ?? 0) + Number(a.applied_cents)
        );
      }
      for (const [wireId, amount] of shrinkByWire.entries()) {
        await db.raw(
          `UPDATE china_wire_transfer
              SET wire_amount_cents = GREATEST(wire_amount_cents - ?, 0),
                  updated_at = now()
            WHERE id = ?`,
          [amount, wireId]
        );
      }

      // Delete cfb rows (china_wire_transfer_application cascades from cfb).
      await db.raw(`DELETE FROM china_finance_bill WHERE id = ANY(?)`, [cfbIds]);
    }

    // FK on vendor_bill_line cascades — bill row + lines are removed.
    await db.raw(`DELETE FROM vendor_bill WHERE id = ?`, [id]);

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  return res.json({ id, deleted: true, hard: true });
}
