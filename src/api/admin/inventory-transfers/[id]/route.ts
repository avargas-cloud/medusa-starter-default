/**
 * src/api/admin/inventory-transfers/[id]/route.ts
 *
 * GET    /admin/inventory-transfers/:id  — detail with lines
 * PATCH  /admin/inventory-transfers/:id  — update draft fields + replace lines
 * DELETE /admin/inventory-transfers/:id  — hard delete (draft only, no linked PO)
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { generateEntityId } from "@medusajs/utils";
import { resolveVendorDisplayName } from "../../../../lib/vendors/vendor-display-name";
import { getActorUserId, UnauthenticatedError } from "../../purchase-orders/_lib/auth";
import {
  extractSupervisorPin,
  guardSupervisorPin,
  pinGuardResponse,
  resolveActorId,
} from "../../../../lib/pos/supervisor-pin-guard";
import type { PinConn } from "../../../../lib/pos/verify-supervisor-pin";
import { rebuildTransferChinaReservations } from "../../../../lib/inventory-transfer-reservations";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../workflows/sync-inventory-item-meilisearch";

// ── Knex type ─────────────────────────────────────────────────────────────────

type KnexInstance = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

function resolveKnex(req: AuthenticatedMedusaRequest): KnexInstance {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as KnexInstance;
}

interface TransferRow {
  id: string;
  number: string | null;
  seq: number | null;
  status: string;
  origin_country: string;
  destination_location_id: string;
  vendor_id: string | null;
  vendor_name_snapshot: string | null;
  linked_purchase_order_id: string | null;
  reference_number: string | null;
  tracking_number: string | null;
  shipper: string | null;
  notes: string | null;
  expected_arrival_at: string | null;
  total_lines: number;
  total_units: number;
  subtotal_cents: number;
  created_by_user_id: string;
  confirmed_at: string | null;
  confirmed_by_user_id: string | null;
  shipped_at: string | null;
  shipped_by_user_id: string | null;
  received_at: string | null;
  received_by_user_id: string | null;
  voided_at: string | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface TransferLineInput {
  product_variant_id: string;
  sku: string;
  description?: string;
  qty: number;
  unit_cost_cents?: number;
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  // linked_po_number joined in, matching the list route — the detail's bare
  // SELECT * silently dropped it and the POS "PO-XXXX" badge rendered "PO-?".
  const transferResult = await knex.raw(
    `SELECT it.*, po.number AS linked_po_number
       FROM inventory_transfer it
       LEFT JOIN purchase_order po
         ON po.id = it.linked_purchase_order_id AND po.deleted_at IS NULL
      WHERE it.id = ? AND it.deleted_at IS NULL`,
    [id]
  );
  const transfer = (transferResult.rows[0] ?? null) as TransferRow | null;
  if (!transfer) {
    return res
      .status(404)
      .json({ error: "Inventory transfer not found", code: "not_found" });
  }

  const linesResult = await knex.raw(
    `SELECT * FROM inventory_transfer_line
     WHERE transfer_id = ? AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [id]
  );

  return res.json({ transfer: { ...transfer, lines: linesResult.rows } });
}

// ── PATCH ─────────────────────────────────────────────────────────────────────

export async function PATCH(
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

  // Suppress unused variable warning — userId kept for future audit use
  void userId;

  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  // PIN de supervisor, verificado ACÁ. La pantalla de Transfer to USA pedía PIN
  // para "habilitar la edición" y comparaba en el navegador: un PATCH directo a
  // esta ruta editaba el transfer —y con él las reservas de stock en China— sin
  // encontrar ninguna puerta.
  {
    const guard = await guardSupervisorPin({
      scope: req.scope as unknown as { resolve: (k: string) => unknown },
      db: knex as unknown as PinConn,
      pin: extractSupervisorPin(req),
      actorId: resolveActorId(req),
    });
    if (!guard.ok) {
      const { status, body } = pinGuardResponse(guard);
      return res.status(status).json(body);
    }
  }

  const lookup = await knex.raw(
    `SELECT id, status, linked_purchase_order_id FROM inventory_transfer WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const existing = (lookup.rows[0] ?? null) as {
    id: string;
    status: string;
    linked_purchase_order_id: string | null;
  } | null;
  if (!existing) {
    return res
      .status(404)
      .json({ error: "Inventory transfer not found", code: "not_found" });
  }
  if (existing.status === "received" || existing.status === "voided") {
    return res.status(409).json({
      error: "Received or voided transfers cannot be edited",
      code: "not_editable",
    });
  }

  const existingVendorLookup = await knex.raw(
    `SELECT vendor_id FROM inventory_transfer WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const existingVendorId =
    (existingVendorLookup.rows[0] as { vendor_id: string | null } | undefined)
      ?.vendor_id ?? null;

  const body = req.body as {
    destination_location_id?: string;
    vendor_id?: string | null;
    vendor_name_snapshot?: string | null;
    reference_number?: string | null;
    tracking_number?: string | null;
    shipper?: string | null;
    notes?: string | null;
    expected_arrival_at?: string | null;
    shipped_at?: string | null;
    lines?: TransferLineInput[];
  };

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updated_at: now };

  if (body.destination_location_id !== undefined)
    updates.destination_location_id = body.destination_location_id.trim();
  if (body.vendor_id !== undefined) updates.vendor_id = body.vendor_id;
  if (body.vendor_name_snapshot !== undefined)
    updates.vendor_name_snapshot = body.vendor_name_snapshot;
  // The display name is resolved server-side from qb_vendor whenever the
  // vendor is (re)identified — the client-sent snapshot is only a fallback.
  {
    const effectiveVendorId =
      body.vendor_id !== undefined ? body.vendor_id : existingVendorId;
    if (
      effectiveVendorId &&
      (body.vendor_id !== undefined || body.vendor_name_snapshot !== undefined)
    ) {
      const vendorRows = await knex.raw(
        `SELECT id, full_name, name, company_name FROM qb_vendor
          WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [effectiveVendorId]
      );
      const vendorRow = vendorRows.rows[0] as
        | { id: string; full_name: string | null; name: string | null; company_name: string | null }
        | undefined;
      if (vendorRow) {
        updates.vendor_name_snapshot =
          resolveVendorDisplayName(vendorRow, body.vendor_name_snapshot ?? null) ??
          body.vendor_name_snapshot ??
          null;
      }
    }
  }
  if (body.reference_number !== undefined)
    updates.reference_number = body.reference_number;
  if (body.tracking_number !== undefined)
    updates.tracking_number = body.tracking_number;
  if (body.shipper !== undefined) updates.shipper = body.shipper;
  if (body.notes !== undefined) updates.notes = body.notes;
  if (body.expected_arrival_at !== undefined)
    updates.expected_arrival_at = body.expected_arrival_at;
  if (body.shipped_at !== undefined)
    updates.shipped_at = body.shipped_at;

  const setClauses = Object.keys(updates)
    .map((k) => `"${k}" = ?`)
    .join(", ");
  const setValues = Object.values(updates);

  await knex.raw(
    `UPDATE inventory_transfer SET ${setClauses} WHERE id = ?`,
    [...setValues, id]
  );

  // Full replace of lines if provided
  if (body.lines !== undefined) {
    // Block if linked PO has already received any items
    if (existing.linked_purchase_order_id) {
      const rcvCheck = await knex.raw(
        `SELECT COUNT(*) AS cnt FROM purchase_order_line
         WHERE purchase_order_id = ? AND qty_received > 0 AND deleted_at IS NULL`,
        [existing.linked_purchase_order_id]
      );
      const received = parseInt(
        String((rcvCheck.rows[0] as { cnt: string }).cnt),
        10
      );
      if (received > 0) {
        return res.status(409).json({
          error:
            `Cannot update lines: ${received} line(s) have already been received on the linked Purchase Order. Delete the associated receipt(s) from the PO first, then retry.`,
          code: "po_partially_received",
        });
      }
    }

    // Soft-delete existing IT lines
    await knex.raw(
      `UPDATE inventory_transfer_line SET deleted_at = ? WHERE transfer_id = ? AND deleted_at IS NULL`,
      [now, id]
    );

    for (const line of body.lines) {
      const lineId = generateEntityId("", "itl");
      await knex.raw(
        `INSERT INTO inventory_transfer_line (
          id, transfer_id, product_variant_id, sku, description,
          qty, unit_cost_cents, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          lineId, id, line.product_variant_id, line.sku,
          line.description ?? "", line.qty,
          line.unit_cost_cents ?? 0, now, now,
        ]
      );
    }

    // Recompute IT totals
    const totalLines = body.lines.length;
    const totalUnits = body.lines.reduce((s, l) => s + l.qty, 0);
    const subtotalCents = body.lines.reduce(
      (s, l) => s + l.qty * (l.unit_cost_cents ?? 0),
      0
    );
    await knex.raw(
      `UPDATE inventory_transfer SET total_lines = ?, total_units = ?, subtotal_cents = ?, updated_at = ? WHERE id = ?`,
      [totalLines, totalUnits, subtotalCents, now, id]
    );

    // Sync linked PO lines
    if (existing.linked_purchase_order_id) {
      const poId = existing.linked_purchase_order_id;
      const variantIds = body.lines.map((line) => line.product_variant_id);
      const variantToItem = new Map<string, string>();
      if (variantIds.length > 0) {
        const placeholders = variantIds.map(() => "?").join(",");
        const itemRes = await knex.raw(
          `SELECT variant_id, inventory_item_id
             FROM product_variant_inventory_item
            WHERE variant_id IN (${placeholders})
              AND deleted_at IS NULL`,
          variantIds
        );
        for (const row of itemRes.rows as Array<{
          variant_id: string;
          inventory_item_id: string;
        }>) {
          variantToItem.set(row.variant_id, row.inventory_item_id);
        }
      }
      const missingVariantIds = variantIds.filter((v) => !variantToItem.has(v));
      if (missingVariantIds.length > 0) {
        return res.status(400).json({
          error: `Missing inventory_item link for variants: ${missingVariantIds.join(", ")}`,
          code: "missing_inventory_item",
        });
      }

      await knex.raw(
        `UPDATE purchase_order_line SET deleted_at = ? WHERE purchase_order_id = ? AND deleted_at IS NULL`,
        [now, poId]
      );

      let poSubtotal = 0;
      let poUnits = 0;
      for (let i = 0; i < body.lines.length; i++) {
        const line = body.lines[i]!;
        const polId = generateEntityId("", "pol");
        const totalCents = line.qty * (line.unit_cost_cents ?? 0);
        poSubtotal += totalCents;
        poUnits += line.qty;
        await knex.raw(
          `INSERT INTO purchase_order_line (
            id, purchase_order_id, product_variant_id, inventory_item_id,
            sku_snapshot, description_snapshot,
            qty_ordered, qty_received, qty_cancelled,
            unit_cost_cents, tax_cents, total_cents,
            status, line_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, 'open', ?, ?, ?)`,
          [
            polId, poId, line.product_variant_id,
            variantToItem.get(line.product_variant_id)!,
            line.sku, line.description ?? "",
            line.qty,
            line.unit_cost_cents ?? 0, totalCents,
            i, now, now,
          ]
        );
      }

      await knex.raw(
        `UPDATE purchase_order SET total_lines = ?, total_units_ordered = ?, subtotal_cents = ?, updated_at = ? WHERE id = ?`,
        [body.lines.length, poUnits, poSubtotal, now, poId]
      );

      const touchedInventoryItemIds = await rebuildTransferChinaReservations(
        knex,
        id,
        poId
      );
      await Promise.allSettled(
        touchedInventoryItemIds.map((inventoryItemId) =>
          syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
            input: { inventoryItemId },
          })
        )
      );
    }
  }

  // Fetch updated transfer + lines
  const transferResult = await knex.raw(
    `SELECT * FROM inventory_transfer WHERE id = ?`,
    [id]
  );
  const linesResult = await knex.raw(
    `SELECT * FROM inventory_transfer_line WHERE transfer_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`,
    [id]
  );

  return res.json({
    transfer: { ...(transferResult.rows[0] as TransferRow), lines: linesResult.rows },
  });
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function DELETE(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  const { id } = req.params as { id: string };
  const knex = resolveKnex(req);

  const lookup = await knex.raw(
    `SELECT id, status, linked_purchase_order_id FROM inventory_transfer WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const existing = (lookup.rows[0] ?? null) as {
    id: string;
    status: string;
    linked_purchase_order_id: string | null;
  } | null;

  if (!existing) {
    return res
      .status(404)
      .json({ error: "Inventory transfer not found", code: "not_found" });
  }
  if (existing.status !== "draft") {
    return res.status(409).json({
      error: "Only draft transfers can be deleted",
      code: "not_draft",
    });
  }
  if (existing.linked_purchase_order_id) {
    return res.status(409).json({
      error: "Transfer has a linked purchase order and cannot be deleted",
      code: "has_linked_po",
    });
  }

  // Hard delete — FK cascade removes lines
  await knex.raw(`DELETE FROM inventory_transfer WHERE id = ?`, [id]);

  return res.json({ id, deleted: true, hard: true });
}
