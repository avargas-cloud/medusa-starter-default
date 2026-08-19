/**
 * POST /admin/factory-orders/:id/receive
 *
 * Records a physical reception against a submitted FactoryOrder.
 * stock_location_id is always China Warehouse (from FO header).
 * No QB fields, no vendor-bill fields.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { receiveFactoryOrderWorkflow } from "../../../../../workflows/factory-orders/receive-factory-order";
import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getFactoryOrdersService } from "../../_lib/service-resolver";
import { receiveSchema } from "../../_lib/validators";

interface FoHeader {
  id: string;
  status: string;
  number: string | null;
  stock_location_id: string;
  vendor_name_snapshot: string | null;
  /** Set only on FOs mirrored from a PO (the SKYDANCE button). */
  linked_purchase_order_id: string | null;
  /** Copied from the PO's `ordered_at` when the mirror created it. */
  ordered_at: string | Date | null;
}

interface FoLine {
  id: string;
  factory_order_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  sku_snapshot: string;
  description_snapshot: string;
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

  const service = getFactoryOrdersService(req);

  const fo = (await service
    .retrieveFactoryOrder(id)
    .catch(() => null)) as unknown as FoHeader | null;
  if (!fo) {
    return res
      .status(404)
      .json({ error: "Factory order not found", code: "not_found" });
  }
  if (fo.status !== "submitted" && fo.status !== "partially_received") {
    return res.status(409).json({
      error: `Cannot receive against a Factory Order in status '${fo.status}'.`,
      code: "not_receivable",
    });
  }
  if (!fo.number) {
    return res.status(409).json({
      error: "Submitted Factory Order is missing number — resubmit first.",
      code: "inconsistent_fo",
    });
  }

  const lineIds = body.lines.map((l) => l.fo_line_id);
  const uniqueLineIds = Array.from(new Set(lineIds));
  if (uniqueLineIds.length !== lineIds.length) {
    return res.status(400).json({
      error: "Each fo_line_id may appear only once per receipt",
      code: "duplicate_line",
    });
  }

  const foLines = (await service.listFactoryOrderLines(
    { id: uniqueLineIds },
    { take: uniqueLineIds.length }
  )) as unknown as FoLine[];
  const byId = new Map(foLines.map((l) => [l.id, l]));

  // Cross-check denormalized qty_received against actual receipt-line sums
  const knex = (req.scope as unknown as {
    resolve: (k: string) => {
      raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
    };
  }).resolve("__pg_connection__");

  const actualReceivedRows = (
    await knex.raw(
      `SELECT frl.factory_order_line_id AS id,
              COALESCE(SUM(frl.qty_received_now), 0)::int AS actual_received
         FROM factory_order_receipt_line frl
         JOIN factory_order_receipt fr ON fr.id = frl.factory_order_receipt_id
        WHERE frl.factory_order_line_id = ANY(?::text[])
          AND frl.deleted_at IS NULL
          AND fr.deleted_at IS NULL
          AND fr.status NOT IN ('voided')
        GROUP BY frl.factory_order_line_id`,
      [uniqueLineIds]
    )
  ).rows as Array<{ id: string; actual_received: number }>;

  const actualByLineId = new Map(
    actualReceivedRows.map((r) => [r.id, r.actual_received])
  );

  const allFullyReceived = body.lines.every((rl) => {
    const pl = byId.get(rl.fo_line_id);
    if (!pl) return false;
    const actual = actualByLineId.get(rl.fo_line_id) ?? pl.qty_received;
    return pl.qty_ordered - actual - pl.qty_cancelled <= 0;
  });
  if (allFullyReceived) {
    return res.status(409).json({
      error: "Every requested line is already fully received.",
      code: "fo_already_complete",
    });
  }

  const workflowLines: Array<{
    fo_line_id: string;
    product_variant_id: string;
    inventory_item_id: string;
    sku_snapshot: string;
    description_snapshot: string;
    qty_received_now: number;
    unit_cost_cents_effective: number;
    unit_cost_cents_override: number | null;
  }> = [];

  for (const req_line of body.lines) {
    const fo_line = byId.get(req_line.fo_line_id);
    if (!fo_line) {
      return res.status(400).json({
        error: `fo_line_id ${req_line.fo_line_id} not found on this FO`,
        code: "line_not_found",
      });
    }
    if (fo_line.factory_order_id !== id) {
      return res.status(400).json({
        error: `fo_line_id ${req_line.fo_line_id} belongs to a different FO`,
        code: "line_mismatch",
      });
    }
    if (fo_line.status === "cancelled") {
      return res.status(400).json({
        error: `fo_line_id ${req_line.fo_line_id} is cancelled`,
        code: "line_cancelled",
      });
    }
    const actualReceived = actualByLineId.get(fo_line.id) ?? fo_line.qty_received;
    const effectiveReceived = Math.max(fo_line.qty_received, actualReceived);
    const remaining = fo_line.qty_ordered - effectiveReceived - fo_line.qty_cancelled;
    if (req_line.qty_received_now > remaining) {
      return res.status(400).json({
        error: `qty_received_now (${req_line.qty_received_now}) exceeds remaining (${remaining}) on line ${req_line.fo_line_id}`,
        code: "qty_overflow",
      });
    }

    const override =
      req_line.unit_cost_cents_override !== undefined &&
      req_line.unit_cost_cents_override !== null
        ? req_line.unit_cost_cents_override
        : null;

    workflowLines.push({
      fo_line_id: fo_line.id,
      product_variant_id: fo_line.product_variant_id,
      inventory_item_id: fo_line.inventory_item_id,
      sku_snapshot: fo_line.sku_snapshot,
      description_snapshot: fo_line.description_snapshot,
      qty_received_now: req_line.qty_received_now,
      unit_cost_cents_effective: override ?? fo_line.unit_cost_cents,
      unit_cost_cents_override: override,
    });
  }

  // A mirrored FO (the SKYDANCE button) documents goods the factory already
  // supplied for a PO that was placed weeks ago, so dating its receipt "today"
  // puts the INFLOW after the transfers that already carried those units to
  // Miami. The China History ledger orders receipts by `received_at` and
  // transfers by `shipped_at`, so the chain then dips negative in the middle and
  // recovers at the bottom — a shortfall the warehouse never had.
  //
  // The FO already carries the PO's date (`factory-order-mirror/route.ts` copies
  // `po.ordered_at` at creation), so it is read from the FO and not from the PO
  // again: a second lookup is a second source that can drift from the first.
  //
  // Only mirrored FOs. A standalone FO is its own document with its own timing,
  // and an explicit `body.received_at` still wins over everything — this is a
  // default, not a lock, so a genuine correction stays possible.
  const mirroredFoDate =
    fo.linked_purchase_order_id && fo.ordered_at ? new Date(fo.ordered_at) : null;
  const receivedAt = body.received_at
    ? new Date(body.received_at)
    : (mirroredFoDate ?? new Date());

  try {
    const { result } = await receiveFactoryOrderWorkflow(req.scope).run({
      input: {
        fo_id: id,
        fo_number: fo.number,
        received_by_user_id: userId,
        stock_location_id: fo.stock_location_id,
        received_at: receivedAt,
        notes: body.notes ?? null,
        lines: workflowLines,
      },
    });
    return res.json({ receipt: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to receive";
    return res.status(400).json({ error: message, code: "receive_failed" });
  }
}
