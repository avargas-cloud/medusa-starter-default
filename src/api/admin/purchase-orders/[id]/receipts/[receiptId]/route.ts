/**
 * src/api/admin/purchase-orders/[id]/receipts/[receiptId]/route.ts
 *
 * DELETE /admin/purchase-orders/:id/receipts/:receiptId
 *
 * Hard-deletes a PurchaseOrderReceipt. Restores inventory, decrements
 * qty_received on PO lines, recomputes PO header status, and (if the
 * receipt was synced to QuickBooks) queues a QB ItemReceipt delete via the
 * existing qb_item_receipt_pipeline.void_status='waiting' lane.
 *
 * Allowed receipt statuses to delete:
 *   - 'applied' / 'synced'  → full flow (contra-stock + decrement + delete)
 *   - 'voided'              → trivial purge (stock + counters already
 *                             reversed at void time; just delete the row,
 *                             waiting for QB delete sync if still pending)
 *
 * Hard-rejects 'pending' (poller hasn't even submitted yet — should be
 * cancelled via the existing pipeline mechanism) and 'deleted' (idempotency).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { deletePurchaseOrderReceiptWorkflow } from "../../../../../../workflows/purchase-orders/delete-purchase-order-receipt";
import { updatePurchaseOrderReceiptWorkflow } from "../../../../../../workflows/purchase-orders/update-purchase-order-receipt";
import { onPoReceiveApplied, onPoReceiveReversed } from "../../../../../../lib/inventory-transfer-link";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../../workflows/sync-inventory-item-meilisearch";
import { getActorUserId, UnauthenticatedError } from "../../../_lib/auth";
import { zodErrorToBody } from "../../../_lib/format";
import { getPurchaseOrdersService } from "../../../_lib/service-resolver";
import {
  deleteReceiptSchema,
  updateReceiptSchema,
} from "../../../_lib/validators";

interface ReceiptHeader {
  id: string;
  purchase_order_id: string;
  status: string;
  stock_location_id: string;
  qb_item_receipt_list_id: string | null;
  voided_at: Date | string | null;
}

interface ReceiptLine {
  id: string;
  purchase_order_line_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string | null;
  qty_received_now: number;
  stock_applied: boolean;
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

  const { id, receiptId } = req.params as { id: string; receiptId: string };
  const parsed = deleteReceiptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getPurchaseOrdersService(req);

  const receipt = (await service
    .retrievePurchaseOrderReceipt(receiptId)
    .catch(() => null)) as unknown as ReceiptHeader | null;
  if (!receipt) {
    return res
      .status(404)
      .json({ error: "Receipt not found", code: "not_found" });
  }
  if (receipt.purchase_order_id !== id) {
    return res.status(400).json({
      error: "Receipt does not belong to this purchase order",
      code: "receipt_mismatch",
    });
  }

  const DELETABLE = ["applied", "synced", "voided"];
  if (!DELETABLE.includes(receipt.status)) {
    return res.status(409).json({
      error: `Cannot delete a receipt in status '${receipt.status}'. Only applied, synced, or voided receipts can be deleted.`,
      code: "not_deletable",
    });
  }

  const billingKnex = (req.scope as unknown as {
    resolve: (key: string) => {
      raw: (
        sql: string,
        bindings?: unknown[]
      ) => Promise<{ rows: unknown[] }>;
    };
  }).resolve("__pg_connection__");
  // Only a POSTED bill blocks the delete. A draft is not yet an accounting
  // fact: nothing has moved AVCO, nothing was sent to QuickBooks, and the
  // bill's own drift banner is what reports lines no longer backed by a
  // receipt. Blocking on draft made the common correction — "this receipt was
  // wrong, redo it" — impossible without first dismantling a bill the operator
  // was still filling in. (2026-08-04)
  //
  // The receipt is detached from whatever draft bills remain linked before its
  // row is destroyed; see lib/purchase-orders/unbind-receipt-from-bills.ts.
  const activeBilling = await billingKnex.raw(
    `SELECT DISTINCT vb.id, vb.number, vb.status
       FROM vendor_bill vb
      WHERE vb.deleted_at IS NULL
        AND vb.status IN ('confirmed', 'synced')
        AND (
          vb.purchase_order_receipt_id = ?
          OR EXISTS (
            SELECT 1
              FROM purchase_order_receipt por
             WHERE por.id = ?
               AND por.vendor_bill_id = vb.id
               AND por.deleted_at IS NULL
          )
          OR EXISTS (
            SELECT 1
              FROM vendor_bill_line vbl
             WHERE vbl.vendor_bill_id = vb.id
               AND vbl.deleted_at IS NULL
               AND vbl.receipt_line_id IN (
                 SELECT id
                   FROM purchase_order_receipt_line
                  WHERE purchase_order_receipt_id = ?
                    AND deleted_at IS NULL
               )
          )
        )
      ORDER BY vb.number`,
    [receiptId, receiptId, receiptId]
  );
  if (activeBilling.rows.length > 0) {
    const names = (activeBilling.rows as Array<{ number: string | null }>)
      .map((b) => b.number)
      .filter(Boolean)
      .join(", ");
    return res.status(409).json({
      error: `This receipt is billed on a confirmed Vendor Bill${names ? ` (${names})` : ""}. Reopen or cancel that bill first; deleting the receipt would break the QuickBooks chain.`,
      code: "receipt_has_active_vendor_bill",
      bills: activeBilling.rows,
    });
  }

  // A legacy/header-only bill may not expose a direct receipt-line link.
  // Protect the global invariant too: deleting this receipt must never leave
  // total POSTED billed qty above the remaining applied receipt qty on a PO
  // line. Drafts are excluded here for the same reason as above — a draft
  // claiming more than was received is exactly the state the bill's drift
  // banner is built to show, not an error to refuse. (2026-08-04)
  const billedFloorAfterDelete = await billingKnex.raw(
    `WITH deleting AS (
       SELECT purchase_order_line_id, SUM(qty_received_now)::int AS qty
         FROM purchase_order_receipt_line
        WHERE purchase_order_receipt_id = ?
          AND deleted_at IS NULL
        GROUP BY purchase_order_line_id
     ),
     received AS (
       SELECT porl.purchase_order_line_id,
              COALESCE(SUM(porl.qty_received_now), 0)::int AS qty
         FROM purchase_order_receipt_line porl
         JOIN purchase_order_receipt por
           ON por.id = porl.purchase_order_receipt_id
          AND por.deleted_at IS NULL
          AND por.status IN ('applied', 'synced')
        WHERE por.purchase_order_id = ?
          AND por.id <> ?
          AND porl.deleted_at IS NULL
        GROUP BY porl.purchase_order_line_id
     ),
     billed AS (
       SELECT vbl.purchase_order_line_id,
              COALESCE(SUM(vbl.qty), 0)::int AS qty
         FROM vendor_bill_line vbl
         JOIN vendor_bill vb
           ON vb.id = vbl.vendor_bill_id
          AND vb.deleted_at IS NULL
          AND vb.purchase_order_id = ?
          AND vb.bill_type = 'regular'
          AND vb.status IN ('confirmed', 'synced')
        WHERE vbl.deleted_at IS NULL
          AND COALESCE(vbl.line_type, 'product') = 'product'
          AND vbl.purchase_order_line_id IN (
            SELECT purchase_order_line_id FROM deleting
          )
        GROUP BY vbl.purchase_order_line_id
     )
     SELECT d.purchase_order_line_id,
            d.qty AS deleting_qty,
            COALESCE(r.qty, 0) AS remaining_received_qty,
            b.qty AS billed_qty
       FROM deleting d
       JOIN billed b ON b.purchase_order_line_id = d.purchase_order_line_id
       LEFT JOIN received r
         ON r.purchase_order_line_id = d.purchase_order_line_id
      WHERE b.qty > COALESCE(r.qty, 0)`,
    [receiptId, id, receiptId, id]
  );
  if (billedFloorAfterDelete.rows.length > 0) {
    return res.status(409).json({
      error:
        "Deleting this receipt would leave one or more PO lines billed above their remaining received quantity. Reduce and reconfirm the Vendor Bill first.",
      code: "receipt_delete_below_billed",
      lines: billedFloorAfterDelete.rows,
    });
  }

  const wasAlreadyVoided = receipt.status === "voided";

  // Collect lines that still need stock reversal (only for applied/synced).
  // For already-voided receipts we pass an empty list — stock parity was
  // already restored at void time.
  let linesToReverse: Array<{
    receipt_line_id: string;
    po_line_id: string;
    inventory_item_id: string;
    sku: string | null;
    qty_applied: number;
  }> = [];
  // Parallel list for Transfer-to-USA China stock restoration
  let transferLines: Array<{
    inventory_item_id: string;
    product_variant_id: string;
    qty: number;
  }> = [];

  if (!wasAlreadyVoided) {
    const rawLines = (await service.listPurchaseOrderReceiptLines(
      { purchase_order_receipt_id: receiptId },
      { take: 1000 }
    )) as unknown as ReceiptLine[];
    const applied = rawLines.filter((l) => l.stock_applied && l.qty_received_now > 0);
    linesToReverse = applied.map((l) => ({
      receipt_line_id: l.id,
      po_line_id: l.purchase_order_line_id,
      inventory_item_id: l.inventory_item_id,
      sku: l.sku_snapshot ?? null,
      qty_applied: l.qty_received_now,
    }));
    transferLines = applied.map((l) => ({
      inventory_item_id: l.inventory_item_id,
      product_variant_id: l.product_variant_id,
      qty: l.qty_received_now,
    }));

    if (linesToReverse.length === 0) {
      return res.status(409).json({
        error: "Receipt has no stock-applied lines to reverse",
        code: "nothing_to_reverse",
      });
    }
  }

  const knex = (req.scope as unknown as {
    resolve: (k: string) => {
      raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  }).resolve("__pg_connection__");

  try {
    const { result } = await deletePurchaseOrderReceiptWorkflow(req.scope).run(
      {
        input: {
          receipt_id: receiptId,
          po_id: id,
          deleted_by_user_id: userId,
          delete_reason: body.delete_reason ?? "Hard delete by user",
          stock_location_id: receipt.stock_location_id,
          lines_to_reverse: linesToReverse,
          was_already_voided: wasAlreadyVoided,
          qb_item_receipt_list_id: receipt.qb_item_receipt_list_id,
        },
      }
    );

    // Transfer-to-USA accounting: restore China stock + revert IT line qty
    if (!wasAlreadyVoided && transferLines.length > 0) {
      await onPoReceiveReversed(knex, id, transferLines);

      // Re-sync MeiliSearch AFTER China stock restore. The delete workflow's
      // own sync runs before onPoReceiveReversed and would publish stale totals.
      await Promise.allSettled(
        transferLines.map((l) =>
          syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
            input: { inventoryItemId: l.inventory_item_id },
          })
        )
      );
    }

    return res.json({ delete: result, warnings: result.warnings ?? [] });
  } catch (err) {
    const e = err as any;
    const message =
      err instanceof Error
        ? err.message
        : typeof e?.message === "string"
          ? e.message
          : Array.isArray(e?.errors) &&
              typeof e.errors[0]?.error?.message === "string"
            ? e.errors[0].error.message
            : "Failed to delete receipt";
    console.error("[delete-receipt] FAILED", {
      message,
      stack: err instanceof Error ? err.stack : e?.stack,
      cause: err instanceof Error ? (err as any).cause : e?.cause,
    });
    return res.status(400).json({ error: message, code: "delete_failed" });
  }
}

interface ReceiptLineRow {
  id: string;
  purchase_order_line_id: string;
  inventory_item_id: string;
  sku_snapshot: string | null;
  qty_received_now: number;
  stock_applied: boolean;
}

interface PoLineRow {
  id: string;
  qty_ordered: number;
  qty_received: number;
  product_variant_id: string;
}

/**
 * PATCH /admin/purchase-orders/:id/receipts/:receiptId
 *
 * Edits an applied receipt:
 *   - vendor_bill_number (packing slip #) — metadata-only update.
 *   - line_qty_changes — adjusts inventory_levels by delta, updates the
 *     receipt line, and recomputes PO line + header counters.
 *
 * Hard-rejects:
 *   - status not in ['applied']  (synced→409 with hint to delete+recreate;
 *                                 voided/error/pending→409 generic).
 *   - new_qty would push a PO line over qty_ordered (cross-receipt sum).
 *   - delta would drive inventory negative at the location.
 */
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

  const { id, receiptId } = req.params as { id: string; receiptId: string };
  const parsed = updateReceiptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getPurchaseOrdersService(req);

  const receipt = (await service
    .retrievePurchaseOrderReceipt(receiptId)
    .catch(() => null)) as unknown as ReceiptHeader | null;
  if (!receipt) {
    return res
      .status(404)
      .json({ error: "Receipt not found", code: "not_found" });
  }
  if (receipt.purchase_order_id !== id) {
    return res.status(400).json({
      error: "Receipt does not belong to this purchase order",
      code: "receipt_mismatch",
    });
  }

  // ItemReceiptMod is the normal correction path now that the bridge builder
  // and PO-scoped dependency chain are shipped. Keep only an explicit
  // emergency kill switch; an unset env must not silently regress operators
  // to delete-and-recreate.
  const qbModEnabled = process.env.QB_ITEM_RECEIPT_MOD_ENABLED !== "false";

  // "Synced to QB" is NOT the receipt header status — the poller leaves the
  // header at 'applied' and records the QB TxnID in qb_item_receipt_list_id.
  // Keying off receipt.status === 'synced' (which never happens in practice)
  // silently skipped the Mod/block logic, so editing a QB-synced receipt
  // mutated Medusa without ever touching QB → divergence → later ItemReceipt
  // 3210 ("LinkToTxn invalid"). Detect QB-sync by the presence of the TxnID.
  const qbSynced = receipt.qb_item_receipt_list_id !== null;

  if (receipt.status !== "applied" && receipt.status !== "synced") {
    return res.status(409).json({
      error: `Cannot edit a receipt in status '${receipt.status}'. Only 'applied' or 'synced' receipts can be edited.`,
      code: "not_editable",
    });
  }
  if (qbSynced && !qbModEnabled) {
    return res.status(409).json({
      error:
        "Receipt is already synced to QuickBooks. Delete and recreate the receipt to make corrections.",
      code: "not_editable_synced",
    });
  }

  // Cross-channel guards: refuse a Mod if the pipeline is in any state
  // that would conflict with a fresh ItemReceiptModRq submission.
  let qbModEnqueueWanted = false;
  if (qbSynced) {
    interface PipeRow {
      id: string;
      status: string | null;
      void_status: string | null;
      mod_status: string | null;
    }
    const pipeKnex = (req.scope as unknown as {
      resolve: (k: string) => {
        raw: (
          sql: string,
          b?: unknown[]
        ) => Promise<{ rows: PipeRow[] }>;
      };
    }).resolve("__pg_connection__");
    const pipeRes = await pipeKnex.raw(
      `SELECT id, status, void_status, mod_status
         FROM qb_item_receipt_pipeline
        WHERE purchase_order_receipt_id = ?
        LIMIT 1`,
      [receiptId]
    );
    const pipe = pipeRes.rows?.[0] ?? null;
    if (!pipe) {
      return res.status(409).json({
        error:
          "Receipt is marked synced but has no QB pipeline row — refusing to Mod.",
        code: "missing_pipeline_row",
      });
    }
    if (pipe.status !== "synced") {
      return res.status(409).json({
        error: `QB Add pipeline for this receipt is in state '${pipe.status}', not 'synced' — wait for it to settle before editing.`,
        code: "add_not_synced",
      });
    }
    if (
      pipe.void_status &&
      pipe.void_status !== "completed" &&
      pipe.void_status !== "failed_permanent"
    ) {
      return res.status(409).json({
        error: `Receipt has a QB void in progress (void_status='${pipe.void_status}'). Cannot edit until void resolves.`,
        code: "void_in_progress",
      });
    }
    if (
      pipe.mod_status === "waiting" ||
      pipe.mod_status === "submitted" ||
      pipe.mod_status === "error"
    ) {
      return res.status(409).json({
        error: `A QB Mod is already pending for this receipt (mod_status='${pipe.mod_status}'). Wait for it to finish or retry from the pipeline view.`,
        code: "mod_in_progress",
      });
    }
    qbModEnqueueWanted = true;
  }

  // Resolve receipt lines + PO lines so we can compute deltas + validate.
  const receiptLines = (await service.listPurchaseOrderReceiptLines(
    { purchase_order_receipt_id: receiptId },
    { take: 1000 }
  )) as unknown as ReceiptLineRow[];
  const receiptLineById = new Map<string, ReceiptLineRow>(
    receiptLines.map((l) => [l.id, l])
  );

  const lineChanges: Array<{
    receipt_line_id: string;
    po_line_id: string;
    inventory_item_id: string;
    product_variant_id: string;
    sku: string | null;
    new_qty: number;
    delta: number;
  }> = [];

  if (body.line_qty_changes && body.line_qty_changes.length > 0) {
    const poLines = (await service.listPurchaseOrderLines(
      { purchase_order_id: id },
      { take: 1000 }
    )) as unknown as PoLineRow[];
    const poLineById = new Map<string, PoLineRow>(
      poLines.map((p) => [p.id, p])
    );

    for (const change of body.line_qty_changes) {
      const rl = receiptLineById.get(change.receipt_line_id);
      if (!rl) {
        return res.status(400).json({
          error: `Receipt line ${change.receipt_line_id} not found on this receipt`,
          code: "line_not_found",
        });
      }
      const pol = poLineById.get(rl.purchase_order_line_id);
      if (!pol) {
        return res.status(400).json({
          error: `PO line ${rl.purchase_order_line_id} not found on this PO`,
          code: "po_line_not_found",
        });
      }

      const delta = change.new_qty - rl.qty_received_now;

      // Cross-receipt cap: total received on this PO line (current snapshot
      // already includes this receipt's prior value) + delta must not exceed
      // qty_ordered.
      const newPoLineReceived = pol.qty_received + delta;
      if (newPoLineReceived > pol.qty_ordered) {
        return res.status(400).json({
          error: `New qty (${change.new_qty}) would exceed open quantity on PO line ${pol.id}. Ordered: ${pol.qty_ordered}, already received across all receipts: ${pol.qty_received - rl.qty_received_now}, max allowed for this receipt: ${pol.qty_ordered - (pol.qty_received - rl.qty_received_now)}.`,
          code: "exceeds_open_qty",
        });
      }
      if (newPoLineReceived < 0) {
        return res.status(400).json({
          error: `New qty (${change.new_qty}) would drive PO line ${pol.id} qty_received negative.`,
          code: "negative_po_qty",
        });
      }

      lineChanges.push({
        receipt_line_id: rl.id,
        po_line_id: pol.id,
        inventory_item_id: rl.inventory_item_id,
        product_variant_id: pol.product_variant_id,
        sku: rl.sku_snapshot ?? null,
        new_qty: change.new_qty,
        delta,
      });
    }

    const reductions = lineChanges.filter((line) => line.delta < 0);
    if (reductions.length > 0) {
      const billingKnex = (req.scope as unknown as {
        resolve: (key: string) => {
          raw: (
            sql: string,
            bindings?: unknown[]
          ) => Promise<{ rows: unknown[] }>;
        };
      }).resolve("__pg_connection__");
      // Only POSTED bills define a billed floor. A draft that claims more than
      // was received is the state the bill's drift banner exists to report,
      // not a reason to refuse the receipt correction. (2026-08-04)
      const billingResult = await billingKnex.raw(
        `SELECT vbl.purchase_order_line_id,
                COALESCE(SUM(vbl.qty), 0)::int AS billed_qty,
                jsonb_agg(DISTINCT jsonb_build_object(
                  'id', vb.id,
                  'number', vb.number,
                  'status', vb.status
                )) AS bills
           FROM vendor_bill_line vbl
           JOIN vendor_bill vb
             ON vb.id = vbl.vendor_bill_id
            AND vb.deleted_at IS NULL
            AND vb.purchase_order_id = ?
            AND vb.bill_type = 'regular'
            AND vb.status IN ('confirmed', 'synced')
          WHERE vbl.purchase_order_line_id = ANY(?)
            AND vbl.deleted_at IS NULL
            AND COALESCE(vbl.line_type, 'product') = 'product'
          GROUP BY vbl.purchase_order_line_id`,
        [id, reductions.map((line) => line.po_line_id)]
      );
      const billedByPoLine = new Map(
        (
          billingResult.rows as Array<{
            purchase_order_line_id: string;
            billed_qty: number | string;
            bills: unknown;
          }>
        ).map((row) => [
          row.purchase_order_line_id,
          {
            billed_qty: Number(row.billed_qty ?? 0),
            bills: row.bills,
          },
        ])
      );
      const adoptedHeaderOnly = await billingKnex.raw(
        `SELECT vb.id, vb.number
           FROM vendor_bill vb
          WHERE vb.purchase_order_id = ?
            AND vb.bill_type = 'regular'
            AND vb.qb_source = 'adopted'
            AND vb.status IN ('confirmed', 'synced')
            AND vb.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM vendor_bill_line vbl
               WHERE vbl.vendor_bill_id = vb.id
                 AND vbl.deleted_at IS NULL
            )
          LIMIT 1`,
        [id]
      );
      if (adoptedHeaderOnly.rows.length > 0) {
        return res.status(409).json({
          error:
            "This PO has an adopted QuickBooks Bill without line quantities. Its billed floor cannot be verified automatically.",
          code: "adopted_bill_qty_unknown",
          bill: adoptedHeaderOnly.rows[0],
        });
      }
      const affected = reductions
        .map((line) => ({
          ...line,
          ...(billedByPoLine.get(line.po_line_id) ?? {
            billed_qty: 0,
            bills: [],
          }),
        }))
        .filter((line) => line.billed_qty > 0);
      const belowBilled = affected.filter(
        (line) => {
          const poLine = poLineById.get(line.po_line_id);
          return (
            Number(poLine?.qty_received ?? 0) + line.delta <
            line.billed_qty
          );
        }
      );
      if (belowBilled.length > 0) {
        return res.status(409).json({
          error:
            "Reduce and reconfirm the linked Vendor Bill before reducing this receipt.",
          code: "receipt_qty_below_billed",
          lines: belowBilled,
        });
      }
      // [REMOVED 2026-08-04] `vendor_bill_revision_pending` used to reject a
      // reduction whenever a draft revision existed. It became unreachable the
      // moment drafts stopped counting toward the billed floor above — leaving
      // it would have been dead code that still reads like a protection.
    }
  }

  const vendor_bill_number_changed = body.vendor_bill_number !== undefined;

  // Only ship a Mod to QB if (a) we're editing a synced receipt AND
  // (b) something QB cares about actually changed. Pure no-op PATCHes
  // (e.g. the UI re-posting the same values) should not pollute the pipeline.
  const hasQtyDelta = lineChanges.some((l) => l.delta !== 0);
  const enqueue_qb_mod =
    qbModEnqueueWanted && (hasQtyDelta || vendor_bill_number_changed);

  try {
    const { result } = await updatePurchaseOrderReceiptWorkflow(req.scope).run(
      {
        input: {
          receipt_id: receiptId,
          po_id: id,
          stock_location_id: receipt.stock_location_id,
          vendor_bill_number: vendor_bill_number_changed
            ? (body.vendor_bill_number ?? null)
            : null,
          vendor_bill_number_changed,
          line_changes: lineChanges,
          enqueue_qb_mod,
        },
      }
    );

    // Transfer-to-USA China delta: mirror what PO receive/delete does.
    // Positive delta = effectively "received more" → decrement China stock.
    // Negative delta = effectively "unreceived some" → restore China stock.
    const activeDeltas = lineChanges.filter((l) => l.delta !== 0);
    if (activeDeltas.length > 0) {
      const updateKnex = (req.scope as unknown as {
        resolve: (k: string) => {
          raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
        };
      }).resolve("__pg_connection__");

      const posDeltas = activeDeltas.filter((l) => l.delta > 0);
      const negDeltas = activeDeltas.filter((l) => l.delta < 0);

      if (posDeltas.length > 0) {
        await onPoReceiveApplied(
          updateKnex,
          id,
          posDeltas.map((l) => ({
            inventory_item_id: l.inventory_item_id,
            product_variant_id: l.product_variant_id,
            qty: l.delta,
          }))
        );
      }
      if (negDeltas.length > 0) {
        await onPoReceiveReversed(
          updateKnex,
          id,
          negDeltas.map((l) => ({
            inventory_item_id: l.inventory_item_id,
            product_variant_id: l.product_variant_id,
            qty: -l.delta,
          }))
        );
      }
      // Re-sync MeiliSearch after China stock changes
      await Promise.allSettled(
        activeDeltas.map((l) =>
          syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
            input: { inventoryItemId: l.inventory_item_id },
          })
        )
      );
    }

    return res.json({ update: result, warnings: result.warnings ?? [] });
  } catch (err) {
    // Medusa's orchestrator does not always throw an Error: a failing step
    // surfaces as an aggregate carrying `errors[].error`. Testing only for
    // `instanceof Error` therefore collapsed EVERY step failure into the
    // useless string "Failed to update receipt" — the operator saw a receipt
    // refuse to save with no reason given, and the real message (negative
    // stock, QB pipeline state) never left the server. DELETE already
    // unwrapped this shape; PATCH did not. (2026-08-04)
    const e = err as any;
    const message =
      err instanceof Error
        ? err.message
        : typeof e?.message === "string"
          ? e.message
          : Array.isArray(e?.errors) &&
              typeof e.errors[0]?.error?.message === "string"
            ? e.errors[0].error.message
            : "Failed to update receipt";
    console.error("[update-receipt] FAILED", {
      message,
      stack: err instanceof Error ? err.stack : e?.stack,
      cause: err instanceof Error ? (err as any).cause : e?.cause,
    });
    return res.status(400).json({ error: message, code: "update_failed" });
  }
}
