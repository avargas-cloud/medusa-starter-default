import { ExecArgs } from "@medusajs/framework/types"

export default async function myScript({ container }: ExecArgs) {
    const base = `http://localhost:${process.env.PORT ?? 9000}`
    
    // Create an auth token to hit the admin API
    const authHeaders = {
        "Authorization": "Basic " + Buffer.from("admin@ecopowertech.com:vQY23WvG").toString("base64")
    }

    try {
        const variant_id = "variant_01KFRNPMS8K91A2HQ49W5JRB88"
        // Let's first login correctly
        const authRes = await fetch(`${base}/auth/user/emailpass`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: "admin@ecopowertech.com", password: "YOUR_PASSWORD" })
        })
        const authJson = await authRes.json()
        const token = authJson.token
        const headers = { Authorization: `Bearer ${token}` }

        const invRes = await fetch(`${base}/admin/inventory-items?variant_id[]=${variant_id}&limit=1`, { headers })
        const json = await invRes.json()
        console.log("Response:", JSON.stringify(json, null, 2))
    } catch(e: any) {
        console.error(e)
    }
}
