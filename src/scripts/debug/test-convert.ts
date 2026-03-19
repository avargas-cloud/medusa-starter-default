import { ExecArgs } from "@medusajs/framework/types"

export default async function myScript({ container }: ExecArgs) {
    const base = `http://localhost:${process.env.PORT ?? 9000}`
    const authHeaders = {
        "Authorization": "Basic " + Buffer.from("admin@ecopowertech.com:vQY23WvG").toString("base64")
    }

    try {
        // Step 1: Login
        const authRes = await fetch(`${base}/auth/user/emailpass`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "admin@ecopowertech.com", password: "YOUR_PASSWORD" })
        })
        const { token } = await authRes.json()
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }

        // Step 2: Ensure we have a draft order to convert... wait, let's just create one manually
        const draftRes = await fetch(`${base}/admin/draft-orders`, {
            method: "POST", headers,
            body: JSON.stringify({
                email: "test@example.com",
                items: [{ variant_id: "variant_01KFRNPMS8K91A2HQ49W5JRB88", quantity: 1, unit_price: 50 }]
            })
        })
        const { draft_order } = await draftRes.json()
        console.log("Created draft:", draft_order?.id)

        if (!draft_order) return

        // Step 3: Call convert-force
        console.log("Calling convert-force...")
        const cvRes = await fetch(`${base}/admin/draft-orders/${draft_order.id}/convert-force`, {
            method: "POST", headers
        })
        const cvBody = await cvRes.text()
        console.log("Convert-force response:", cvBody)
    } catch(e) {
        console.error(e)
    }
}
