import { initialize } from "@medusajs/framework/api"
import { ContainerRegistrationKeys } from "@medusajs/utils"

async function run() {
    console.log("Initializing Medusa...")
    const { container } = await initialize({ projectConfig: {} } as any)
    const eventBus = container.resolve(ContainerRegistrationKeys.EVENT_BUS)
    
    console.log("Emitting pos.payment.created...")
    await eventBus.emit({
        name: "pos.payment.created",
        data: { id: "test-payment-id" }
    })
    
    console.log("Event emitted. Waiting 3 seconds for subscriber...")
    await new Promise(r => setTimeout(r, 3000))
    console.log("Done.")
    process.exit(0)
}

run().catch(console.error)
