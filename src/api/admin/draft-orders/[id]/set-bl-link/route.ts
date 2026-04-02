import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"
import { Modules } from "@medusajs/utils"

/**
 * POST /admin/draft-orders/:id/set-bl-link
 *
 * Persists the Backlighting project link into the draft order's metadata
 * using the Order module directly — avoids the client-side metadata PATCH
 * that was silently failing.
 *
 * Body: { backlighting_project_id: string, backlighting_seq_id?: string | null }
 *
 * Merges into existing metadata (does not overwrite other fields).
 */
export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    const { id } = req.params as { id: string }
    const { backlighting_project_id, backlighting_seq_id, linked_by } = req.body as {
        backlighting_project_id: string
        backlighting_seq_id?: string | null
        linked_by?: string | null
    }

    console.log(`[set-bl-link] REQUEST order=${id} bl_project=${backlighting_project_id ?? "(missing)"} seq=${backlighting_seq_id ?? "null"}`)

    if (!backlighting_project_id) {
        console.warn(`[set-bl-link] 400 — backlighting_project_id missing for order=${id}`)
        res.status(400).json({ message: "backlighting_project_id is required" })
        return
    }

    try {
        const orderModule = req.scope.resolve(Modules.ORDER) as any

        // Fetch current order to merge metadata (Medusa v2 replaces, not merges)
        const [order] = await orderModule.listOrders(
            { id: [id] },
            { select: ["id", "metadata"] }
        ) as any[]

        if (!order) {
            console.warn(`[set-bl-link] 404 — order=${id} not found in orderModule`)
            res.status(404).json({ message: `Draft order ${id} not found` })
            return
        }

        const currentMetadata: Record<string, unknown> = (order.metadata as Record<string, unknown>) ?? {}
        console.log(`[set-bl-link] current metadata keys=${Object.keys(currentMetadata).join(",") || "(none)"}`)

        const updatedMetadata = {
            ...currentMetadata,
            backlighting_project_id,
            backlighting_seq_id: backlighting_seq_id ?? null,
            backlighting_linked_at: new Date().toISOString(),
            backlighting_linked_by: linked_by ?? null,
        }

        await orderModule.updateOrders([{ id, metadata: updatedMetadata }])

        console.log(`[set-bl-link] OK order=${id} bl_project=${backlighting_project_id} seq=${backlighting_seq_id ?? "null"}`)

        res.status(200).json({ success: true })
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to set BL link"
        console.error("[set-bl-link] ERROR order=${id}:", msg, e instanceof Error ? e.stack : "")
        res.status(500).json({ message: msg })
    }
}
