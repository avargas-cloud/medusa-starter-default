import type { MedusaRequest, MedusaResponse } from "@medusajs/framework"

/**
 * POST /admin/orders/:id/update-force
 *
 * Updates metadata, customer_id, and addresses on a confirmed order.
 * Mirrors what POST /admin/draft-orders/:id does for drafts.
 *
 * Proxies to Medusa native POST /admin/orders/:id with the given body.
 * Supported fields: customer_id, email, shipping_address, billing_address, metadata
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const { id } = req.params as { id: string }
    const body = req.body as Record<string, any>

    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders: Record<string, string> = {
        "Cookie": String(req.headers["cookie"] ?? ""),
        "Authorization": String(req.headers["authorization"] ?? ""),
        "Content-Type": "application/json",
    }

    try {
        const updateRes = await fetch(`${base}/admin/orders/${id}`, {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify(body),
        })

        const json = await updateRes.json()
        if (!updateRes.ok) {
            console.error(`[orders/update-force] Failed to update order ${id}:`, json?.message)
            return void res.status(updateRes.status).json(json)
        }

        console.log(`[orders/update-force] Updated order ${id}`)
        res.status(200).json(json)
    } catch (e: any) {
        console.error("[orders/update-force]", e?.message)
        res.status(500).json({ message: e?.message ?? "Failed to update order" })
    }
}
