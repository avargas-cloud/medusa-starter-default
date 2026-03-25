import { bridgeFetch } from '../lib/quickbooks/client/core'

export default async function run({ container }: any) {
    console.log("=== Testing Minimal CustomerMod ===")

    const listId = "8000004E-1342117388"
    
    // 1. Get EditSequence using native Medusa order-flow logic
    const { getCustomerEditSequence } = require('../lib/quickbooks/client/core')
    const editSeq = await getCustomerEditSequence(listId, console.log)
    if (!editSeq) throw new Error("No EditSequence")
    console.log("Got EditSequence:", editSeq)

    // 2. Test updating name + addresses
    const payload = {
        FirstName: "Alejandro",
        LastName: "Vargas",
        EditSequence: editSeq,
        BillAddress: { Addr1: "2760 W 84th St", City: "Hialeah", State: "FL", PostalCode: "33016" },
        ShipAddress: { Addr1: "111 Principal", City: "Miami", State: "FL", PostalCode: "33016" }
    }

    let res = await bridgeFetch("PUT", `/api/customers/${listId}`, payload)
    
    let opId = res.operationId
    console.log(`Queued mod (ID ${opId})`)
    
    while(true) {
        await new Promise(r => setTimeout(r, 5000))
        let status = await bridgeFetch("GET", `/api/sync/status/${opId}`)
        if (status?.operation?.status === "completed") {
            console.log("✅ SUCCESS! Full mod worked!")
            break
        } else if (status?.operation?.status === "failed") {
            console.error("❌ FAILED!", status.operation.error)
            break
        }
        console.log("Waiting for WC...")
    }
}

