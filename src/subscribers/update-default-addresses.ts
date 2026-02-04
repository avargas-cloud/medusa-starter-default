import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { updateCustomersWorkflow } from "@medusajs/medusa/core-flows"

/**
 * Subscriber: Auto-update customer default addresses
 * 
 * Listens to address.created and address.updated events
 * If metadata.is_default_billing or metadata.is_default_shipping is true,
 * updates customer.default_billing_address_id or customer.default_shipping_address_id
 */
export default async function handleAddressUpdate({
    event: { data },
    container
}: SubscriberArgs<{ id: string }>) {

    const query = container.resolve("query")

    // Get the address with metadata
    const { data: [address] } = await query.graph({
        entity: "address",
        fields: ["id", "customer_id", "metadata"],
        filters: { id: data.id }
    })

    if (!address || !address.customer_id) {
        return // Not a customer address
    }

    const metadata = address.metadata || {}
    const customerUpdate: any = {}

    // Check if this address should be set as default billing
    if (metadata.is_default_billing === true) {
        customerUpdate.default_billing_address_id = address.id
        console.log(`✅ Setting default billing address: ${address.id}`)
    }

    // Check if this address should be set as default shipping
    if (metadata.is_default_shipping === true) {
        customerUpdate.default_shipping_address_id = address.id
        console.log(`✅ Setting default shipping address: ${address.id}`)
    }

    // Update customer if needed
    if (Object.keys(customerUpdate).length > 0) {
        await updateCustomersWorkflow(container)
            .run({
                input: {
                    selector: { id: address.customer_id },
                    update: customerUpdate
                }
            })
        console.log(`✅ Customer ${address.customer_id} default addresses updated`)
    }
}

export const config: SubscriberConfig = {
    event: [
        "address.created",
        "address.updated"
    ]
}
