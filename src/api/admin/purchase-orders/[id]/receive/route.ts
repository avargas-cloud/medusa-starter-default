/**
 * src/api/admin/purchase-orders/[id]/receive/route.ts
 *
 * POST /admin/purchase-orders/:id/receive
 *
 * Records a physical receipt. Resolves PO lines server-side from the
 * po_line_id + qty_received_now pairs in the body, validates:
 *   - PO is submitted / partially_received
 *   - every po_line_id belongs to this PO and is open/partial
 *   - qty_received_now ≤ remaining qty on that line
 *
 * Then invokes receivePurchaseOrderWorkflow (allocates RCP-{seq}, applies
 * stock, persists receipt, enqueues QB ItemReceipt).
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { receivePurchaseOrderWorkflow } from "../../../../../workflows/purchase-orders/receive-purchase-order";
import { onPoReceiveApplied } from "../../../../../lib/inventory-transfer-link";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";
import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getPurchaseOrdersService } from "../../_lib/service-resolver";
import { receiveSchema } from "../../_lib/validators";

interface PoHeader {
  id: string;
  status: string;
  number: string | null;
  stock_location_id: string;
  vendor_id: string;
  vendor_name_snapshot: string | null;
  vendor_qb_list_id_snapshot: string | null;
  qb_purchase_order_list_id: string | null;
}

interface PoLine {
  id: string;
  purchase_order_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
  qb_item_list_id_snapshot: string | null;
  qb_txn_line_id: string | null;
  qty_ordered: number;
  qty_received: number;
  qty_cancelled: number;
  unit_cost_cents: number;
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
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = receiveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getPurchaseOrdersService(req);

  const po = (await service
    .retrievePurchaseOrder(id)
    .catch(() => null)) as unknown as PoHeader | null;
  if (!po) {
    return res
      .status(404)
      .json({ error: "Purchase order not found", code: "not_found" });
  }
  if (po.status !== "submitted" && po.status !== "partially_received") {
    return res.status(409).json({
      error: `Cannot receive against a PO in status '${po.status}'.`,
      code: "not_receivable",
    });
  }
  if (
    !po.vendor_qb_list_id_snapshot ||
    !po.vendor_name_snapshot ||
    !po.number
  ) {
    return res.status(409).json({
      error:
        "Submitted PO is missing vendor snapshot / number — resubmit first.",
      code: "inconsistent_po",
    });
  }

  // Load all PO lines referenced in the request
  const lineIds = body.lines.map((l) => l.po_line_id);
  const uniqueLineIds = Array.from(new Set(lineIds));
  if (uniqueLineIds.length !== lineIds.length) {
    return res.status(400).json({
      error: "Each po_line_id may appear only once per receipt",
      code: "duplicate_line",
    });
  }

  const poLines = (await service.listPurchaseOrderLines(
    { id: uniqueLineIds },
    { take: uniqueLineIds.length }
  )) as unknown as PoLine[];
  const byId = new Map(poLines.map((l) => [l.id, l]));

  // Defense in depth: cross-check denormalized po_line.qty_received against
  // SUM(receipt_line.qty_received_now) over all non-voided/non-deleted
  // receipts. Counter drift (production incident 2026-04-27) lets stale
  // counters re-open already-received lines for double-receive.
  const knex = (req.scope as unknown as {
    resolve: (k: string) => {
      raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  }).resolve("__pg_connection__");
  const actualReceivedRows = (
    await knex.raw(
      `SELECT prl.purchase_order_line_id AS id,
              COALESCE(SUM(prl.qty_received_now), 0)::int AS actual_received
         FROM purchase_order_receipt_line prl
         JOIN purchase_order_receipt pr ON pr.id = prl.purchase_order_receipt_id
        WHERE prl.purchase_order_line_id = ANY (?::text[])
          AND prl.deleted_at IS NULL
          AND pr.deleted_at IS NULL
          AND pr.status NOT IN ('voided','deleted')
        GROUP BY prl.purchase_order_line_id`,
      [uniqueLineIds]
    )
  ).rows as Array<{ id: string; actual_received: number }>;
  const actualByLineId = new Map(
    actualReceivedRows.map((r) => [r.id, r.actual_received])
  );

  // Reject if every requested line is fully received per actual receipts
  const allFullyReceived = body.lines.every((rl) => {
    const pl = byId.get(rl.po_line_id);
    if (!pl) return false;
    const actual = actualByLineId.get(rl.po_line_id) ?? pl.qty_received;
    return pl.qty_ordered - actual - pl.qty_cancelled <= 0;
  });
  if (allFullyReceived) {
    return res.status(409).json({
      error:
        "Every requested line is already fully received. Refresh the PO — its counters may be stale.",
      code: "po_already_complete",
    });
  }

  // Validate every requested line
  const workflowLines: Array<{
    po_line_id: string;
    product_variant_id: string;
    inventory_item_id: string;
    sku_snapshot: string;
    description_snapshot: string;
    qb_item_list_id_snapshot: string | null;
    qb_po_txn_line_id: string | null;
    qty_received_now: number;
    unit_cost_cents_effective: number;
    unit_cost_cents_override: number | null;
  }> = [];

  for (const req_line of body.lines) {
    const po_line = byId.get(req_line.po_line_id);
    if (!po_line) {
      return res.status(400).json({
        error: `po_line_id ${req_line.po_line_id} not found on this PO`,
        code: "line_not_found",
      });
    }
    if (po_line.purchase_order_id !== id) {
      return res.status(400).json({
        error: `po_line_id ${req_line.po_line_id} belongs to a different PO`,
        code: "line_mismatch",
      });
    }
    if (po_line.status === "cancelled") {
      return res.status(400).json({
        error: `po_line_id ${req_line.po_line_id} is cancelled`,
        code: "line_cancelled",
      });
    }
    // Use MAX(stored, actual) so stale denormalized counters can never
    // permit double-receive: we always trust the higher of the two truths.
    const actualReceived = actualByLineId.get(po_line.id) ?? po_line.qty_received;
    const effectiveReceived = Math.max(po_line.qty_received, actualReceived);
    const remaining =
      po_line.qty_ordered - effectiveReceived - po_line.qty_cancelled;
    if (req_line.qty_received_now > remaining) {
      return res.status(400).json({
        error: `qty_received_now (${req_line.qty_received_now}) exceeds remaining (${remaining}) on line ${req_line.po_line_id}`,
        code: "qty_overflow",
      });
    }

    const override =
      req_line.unit_cost_cents_override !== undefined &&
      req_line.unit_cost_cents_override !== null
        ? req_line.unit_cost_cents_override
        : null;
    const effective = override ?? po_line.unit_cost_cents;

    workflowLines.push({
      po_line_id: po_line.id,
      product_variant_id: po_line.product_variant_id,
      inventory_item_id: po_line.inventory_item_id,
      sku_snapshot: po_line.sku_snapshot,
      description_snapshot: po_line.description_snapshot,
      qb_item_list_id_snapshot: po_line.qb_item_list_id_snapshot,
      qb_po_txn_line_id: po_line.qb_txn_line_id ?? null,
      qty_received_now: req_line.qty_received_now,
      unit_cost_cents_effective: effective,
      unit_cost_cents_override: override,
    });
  }

  const receivedAt = body.received_at ? new Date(body.received_at) : new Date();
  const stockLocationId = body.stock_location_id ?? po.stock_location_id;
  const qbMemo =
    body.qb_memo ?? `${po.number} bill#${body.vendor_bill_number ?? "—"}`;

  try {
    const { result } = await receivePurchaseOrderWorkflow(req.scope).run({
      input: {
        po_id: id,
        po_number: po.number,
        vendor_qb_list_id: po.vendor_qb_list_id_snapshot,
        vendor_name: po.vendor_name_snapshot,
        qb_po_list_id: po.qb_purchase_order_list_id ?? null,
        qb_inventory_site_list_id: null,
        received_by_user_id: userId,
        stock_location_id: stockLocationId,
        received_at: receivedAt,
        vendor_bill_number: body.vendor_bill_number ?? null,
        vendor_bill_date: body.vendor_bill_date
          ? new Date(body.vendor_bill_date)
          : null,
        notes: body.notes ?? null,
        qb_memo: qbMemo,
        lines: workflowLines,
      },
    });

    // Transfer-to-USA accounting: deduct from China stock + track IT line qty
    await onPoReceiveApplied(
      knex,
      id,
      workflowLines.map((l) => ({
        inventory_item_id: l.inventory_item_id,
        product_variant_id: l.product_variant_id,
        qty: l.qty_received_now,
      }))
    );

    // Re-sync MeiliSearch AFTER the China stock deduction. The workflow's
    // own sync step runs before onPoReceiveApplied and would publish stale
    // China totals.
    await Promise.allSettled(
      workflowLines.map((l) =>
        syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
          input: { inventoryItemId: l.inventory_item_id },
        })
      )
    );

    return res.json({ receipt: result });
  } catch (err) {
    // The request body already passed validation above; a failure here is a
    // runtime workflow error (missing inventory level, QB enqueue, etc.), not
    // a malformed request. Surface 422 with the real message so the operator
    // sees the actual cause instead of a generic 400.
    const message = err instanceof Error ? err.message : "Failed to receive";
    return res.status(422).json({ error: message, code: "receive_failed" });
  }
}
