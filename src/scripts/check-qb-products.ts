import "dotenv/config"
import fs from "fs"

const BRIDGE_URL = process.env.QB_BRIDGE_URL || "https://qb.eptbridge.com"
const API_KEY = process.env.QB_API_KEY || "mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD"

async function run() {
    console.log("Requesting Bulk Data from Bridge...")
    const initRes = await fetch(`${BRIDGE_URL}/api/products`, {
        headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
    })

    if (!initRes.ok) {
        console.error(`Bridge Error: ${initRes.status}`)
        return
    }

    const initJson = await initRes.json()
    const operationId = initJson.operationId
    console.log(`✅ Operation Queued! ID: ${operationId}`)

    let attempts = 0
    while (attempts < 20) {
        attempts++
        console.log(`⏳ Polling Status (${attempts}/20)...`)
        await new Promise(r => setTimeout(r, 10000))

        const statusRes = await fetch(`${BRIDGE_URL}/api/sync/status/${operationId}`, {
            headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" }
        })

        if (!statusRes.ok) continue

        const statusJson = await statusRes.json()
        if (statusJson.success && statusJson.operation) {
            if (statusJson.operation.status === "completed") {
                const queryRs = statusJson.operation?.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs
                const qbData = queryRs?.ItemInventoryRet || []
                
                fs.writeFileSync("/home/alejo/webapps/ecopowertech-workspace/backend/qb_price_sync_output.json", JSON.stringify(qbData, null, 2))
                console.log(`✅ Data Received! Saved to qb_price_sync_output.json`)
                break
            }
            if (statusJson.operation.status === "failed") {
                console.error(`QB sync failed: ${statusJson.operation.error}`)
                return
            }
        }
    }
}

run()
