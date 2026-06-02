/**
 * POST /admin/factory-orders/:id/close
 * Manually closes a FactoryOrder — remaining open qty is forfeited.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { Modules } from "@medusajs/utils";

import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getFactoryOrdersService } from "../../_lib/service-resolver";
import { closeSchema } from "../../_lib/validators";
import { getDbPool } from "../../../../utils/db-pool";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../../../../workflows/sync-inventory-item-meilisearch";

interface FoLine {
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
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const body = parsed.data;

  const service = getFactoryOrdersService(req);

  const fo = (await service
    .retrieveFactoryOrder(id)
    .catch(() => null)) as unknown as {
    id: string;
    status: string;
    stock_location_id: string;
  } | null;
  if (!fo) {
    return res
      .status(404)
      .json({ error: "Factory order not found", code: "not_found" });
  }
  if (fo.status !== "submitted" && fo.status !== "partially_received") {
    return res.status(409).json({
      error: `Cannot close a Factory Order in status '${fo.status}'.`,
      code: "not_closable",
    });
  }

  const lines = (await service.listFactoryOrderLines(
    { factory_order_id: id },
    { take: 1000, skip: 0 }
  )) as unknown as FoLine[];

  const lineUpdates = lines
    .filter((l) => l.status !== "cancelled" && l.status !== "complete")
    .map((l) => {
      const remaining = l.qty_ordered - l.qty_received - l.qty_cancelled;
      return {
        id: l.id,
        qty_cancelled: l.qty_cancelled + Math.max(0, remaining),
        status: (l.qty_received > 0 ? "partial" : "cancelled") as
          | "partial"
          | "cancelled",
      };
    });

  if (lineUpdates.length > 0) {
    await service.updateFactoryOrderLines(lineUpdates);
  }

  // Reverse China inventory for all quantities already received on this FO.
  // Receipts that were individually deleted already had their stock reversed
  // by delete-factory-order-receipt workflow — exclude voided receipts.
  const pool = getDbPool();
  const { rows: receivedItems } = await pool.query<{
    inventory_item_id: string;
    total_received: number;
  }>(
    `SELECT frl.inventory_item_id, SUM(frl.qty_received_now)::int AS total_received
       FROM factory_order_receipt_line frl
       JOIN factory_order_receipt fr ON fr.id = frl.factory_order_receipt_id
      WHERE fr.factory_order_id = $1
        AND fr.deleted_at IS NULL
        AND frl.deleted_at IS NULL
        AND fr.status NOT IN ('voided')
      GROUP BY frl.inventory_item_id
      HAVING SUM(frl.qty_received_now) > 0`,
    [id]
  );

  if (receivedItems.length > 0) {
    const inventoryModule = req.scope.resolve(Modules.INVENTORY) as any;
    for (const item of receivedItems) {
      try {
        await inventoryModule.adjustInventory(
          item.inventory_item_id,
          fo.stock_location_id,
          -item.total_received
        );
      } catch (invErr: any) {
        console.warn(
          `[FO close] inventory reversal failed for ${item.inventory_item_id}: ${invErr?.message}`
        );
      }
    }
    await Promise.allSettled(
      receivedItems.map(({ inventory_item_id }) =>
        syncInventoryItemToMeiliSearchWorkflow(req.scope).run({
          input: { inventoryItemId: inventory_item_id },
        })
      )
    );
  }

  const [updated] = await service.updateFactoryOrders([
    {
      id,
      status: "closed",
      closed_at: new Date(),
      closed_by_user_id: userId,
      close_reason: body.close_reason,
    },
  ]);

  return res.json({ factory_order: updated });
}
