import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

/**
 * POST /admin/draft-orders/:id/set-ll-link
 *
 * Persists the Linear Lighting project link into the (draft) order's
 * metadata using the Order module directly — mirror of set-bl-link, which
 * exists because the client-side metadata PATCH silently failed.
 *
 * Body: { ll_project_id: string, ll_seq_id?: string | null }
 *
 * Merges into existing metadata (does not overwrite other fields).
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const { id } = req.params as { id: string };
  const { ll_project_id, ll_seq_id, linked_by } = req.body as {
    ll_project_id: string;
    ll_seq_id?: string | null;
    linked_by?: string | null;
  };

  if (!ll_project_id) {
    res.status(400).json({ message: "ll_project_id is required" });
    return;
  }

  try {
    const orderModule = req.scope.resolve(Modules.ORDER) as any;

    // Fetch current order to merge metadata (Medusa v2 replaces, not merges)
    const [order] = (await orderModule.listOrders(
      { id: [id] },
      { select: ["id", "metadata"] }
    )) as any[];

    if (!order) {
      res.status(404).json({ message: `Draft order ${id} not found` });
      return;
    }

    const currentMetadata: Record<string, unknown> =
      (order.metadata as Record<string, unknown>) ?? {};

    const updatedMetadata = {
      ...currentMetadata,
      ll_project_id,
      ll_seq_id: ll_seq_id ?? null,
      ll_linked_at: new Date().toISOString(),
      ll_linked_by: linked_by ?? null,
    };

    await orderModule.updateOrders([{ id, metadata: updatedMetadata }]);

    console.log(
      `[set-ll-link] OK order=${id} ll_project=${ll_project_id} seq=${ll_seq_id ?? "null"}`
    );

    res.status(200).json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Failed to set LL link";
    console.error(`[set-ll-link] ERROR order=${id}:`, msg);
    res.status(500).json({ message: msg });
  }
}
