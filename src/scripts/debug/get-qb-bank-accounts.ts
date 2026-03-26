import 'dotenv/config'
import { bridgeFetch, pollOperationResult } from '../../lib/quickbooks/client/core'

async function run() {
    console.log("⏳ Fetching Bank Accounts from QuickBooks Desktop...")
    
    try {
        const enqueueRes = await bridgeFetch("POST", "/api/sync/enqueue", {
            type: "account",
            action: "query",
            data: { AccountType: "Bank", ActiveStatus: "ActiveOnly" }
        })

        if (!enqueueRes.operation_id) {
            throw new Error("Failed to enqueue AccountQueryRq")
        }

        const result = await pollOperationResult(enqueueRes.operation_id, console.log)
        
        if ((result as any).status === 'failed') {
            console.error("❌ Failed to query accounts from QB:", (result as any).error)
            return
        }

        // Parse result
        let accounts = (result as any).result?.AccountRet || (result as any).result?.QBXML?.QBXMLMsgsRs?.AccountQueryRs?.AccountRet
        if (!accounts) {
             console.log("No bank accounts found.")
             return
        }
        
        if (!Array.isArray(accounts)) accounts = [accounts]

        console.log("\n🏦 ✅ ENCONTRADAS LAS SIGUIENTES CUENTAS BANCARIAS EN QUICKBOOKS:")
        console.log("================================================================")
        for (const acc of accounts) {
             console.log(`Nombre: ${acc.FullName.padEnd(30)} | ListID: ${acc.ListID}`)
        }
        console.log("================================================================\n")
        console.log("Copia el ListID de la cuenta que desees y pégalo en el POS para mapearlo al refund.")

    } catch (e: any) {
        console.error("❌ Error running script:", e.message)
    }
}

run()
