/**
 * POST /admin/purchase-orders/:id/void
 *
 * Voids a submitted or partially-received PO. Cancels all remaining open lines,
 * marks the PO voided, and—if the PO is already synced to QB—queues a
 * PurchaseOrderModRq with IsManuallyClosed=true to close it on the QB side.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { onPoVoided } from "../../../../../lib/inventory-transfer-link";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";
import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { voidReceiptSchema } from "../../_lib/validators";
import { zodErrorToBody } from "../../_lib/format";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";

interface PoHeader {
  id: string;
  status: string;
  number: string | null;
  qb_purchase_order_list_id: string | null;
  qb_edit_sequence: string | null;
  vendor_qb_list_id_snapshot: string | null;
  vendor_name_snapshot: string | null;
}

interface PoLine {
  id: string;
  qty_ordered: number;
  qty_received: number;
  qty_cancelled: number;
  status: string;
}

export async function POST(
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
  const parsed = voidReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { void_reason } = parsed.data;

  const service = getPurchaseOrdersService(req);
  const knex = (req.scope as unknown as {
    resolve: (k: string) => {
      raw: (
        sql: string,
        b?: unknown[]
      ) => Promise<{ rows: unknown[]; rowCount?: number }>;
    };
  }).resolve("__pg_connection__");

  const po = (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as unknown as PoHeader | null;
  if (!po) {
    return res.status(404).json({ error: "Purchase order not found", code: "not_found" });
  }
  // Void allowed on submitted, partially_received, AND received POs.
  // For received POs the line cancellation loop is a no-op (all lines are
  // already 'complete'), but the PO header is still marked voided + queued
  // to QB. If the user also wants inventory back, they must delete the
  // underlying receipts first.
  const VOIDABLE = ["submitted", "partially_received", "received"];
  if (!VOIDABLE.includes(po.status)) {
    return res.status(409).json({
      error: `Cannot void a PO in status '${po.status}'.`,
      code: "not_voidable",
    });
  }

  // Cancel remaining open lines
  const lines = (await service.listPurchaseOrderLines(
    { purchase_order_id: id },
    { take: 1000, skip: 0 }
  )) as unknown as PoLine[];

  const lineUpdates = lines
    .filter((l) => l.status !== "cancelled" && l.status !== "complete")
    .map((l) => {
      const remaining = l.qty_ordered - l.qty_received - l.qty_cancelled;
      return {
        id: l.id,
        qty_cancelled: l.qty_cancelled + Math.max(0, remaining),
        status: (l.qty_received > 0 ? "partial" : "cancelled") as "partial" | "cancelled",
      };
    });

  if (lineUpdates.length > 0) {
    await service.updatePurchaseOrderLines(lineUpdates);
  }

  const [updated] = await service.updatePurchaseOrders([
    {
      id,
      status: "voided",
      voided_at: new Date(),
      voided_by_user_id: userId,
      void_reason,
    },
  ]);

  // If synced to QB, queue a close (IsManuallyClosed=true). `qb_purchase_order_pipeline`
  // has a unique index on purchase_order_id (one row per PO) — a synced PO already owns
  // a row, so this MUST reset that row rather than insert a second one (mirrors the
  // UPDATE-first/INSERT-fallback pattern used by the PATCH mod path in [id]/route.ts).
  if (po.qb_purchase_order_list_id) {
    const voidPayload = {
      is_void: true,
      txn_id: po.qb_purchase_order_list_id,
      edit_sequence: po.qb_edit_sequence ?? null,
      po_id: id,
      po_number: po.number,
      vendor_qb_list_id: po.vendor_qb_list_id_snapshot,
      vendor_name: po.vendor_name_snapshot,
    };
    try {
      const result = await knex.raw(
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
        [JSON.stringify(voidPayload), id]
      );
      if ((result.rowCount ?? 0) === 0) {
        await service.createQbPurchaseOrderPipelines([
          { purchase_order_id: id, status: "waiting", payload: voidPayload },
        ]);
      }
    } catch (qbErr) {
      // Non-fatal: the local void already succeeded; QB close will need a manual retry.
      console.error("[po-void] Failed to enqueue QB close:", qbErr);
    }
  }

  // Transfer-to-USA accounting: void the linked IT (goods return to China)
  const touchedInventoryItemIds = await onPoVoided(knex, id, userId);
  await Promise.allSettled(
    touchedInventoryItemIds.map((inventoryItemId) =>
      syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
        input: { inventoryItemId },
      })
    )
  );

  return res.json({ purchase_order: updated });
}
