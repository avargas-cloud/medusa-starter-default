/**
 * POST /admin/factory-orders/:id/void
 * Voids a submitted / partially-received / received FO.
 * No QB pipeline entry — factory orders are Medusa-only.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { zodErrorToBody } from "../../_lib/format";
import { getFactoryOrdersService } from "../../_lib/service-resolver";
import { voidSchema } from "../../_lib/validators";

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
  const parsed = voidSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }
  const { void_reason } = parsed.data;

  const service = getFactoryOrdersService(req);

  const fo = (await service
    .retrieveFactoryOrder(id)
    .catch(() => null)) as unknown as { id: string; status: string } | null;
  if (!fo) {
    return res
      .status(404)
      .json({ error: "Factory order not found", code: "not_found" });
  }

  const VOIDABLE = ["submitted", "partially_received", "received"];
  if (!VOIDABLE.includes(fo.status)) {
    return res.status(409).json({
      error: `Cannot void a Factory Order in status '${fo.status}'.`,
      code: "not_voidable",
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

  const [updated] = await service.updateFactoryOrders([
    {
      id,
      status: "voided",
      voided_at: new Date(),
      voided_by_user_id: userId,
      void_reason,
    },
  ]);

  return res.json({ factory_order: updated });
}
