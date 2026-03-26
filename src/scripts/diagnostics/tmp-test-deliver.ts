import { createOrderShipmentWorkflow } from "@medusajs/core-flows";

export default async function queryPayments({ container }: { container: any }) {
    const fulfillmentId = 'ful_01KMKXEYVZMXQFAG4YN4C1VCGP';
    const orderId = 'order_01KMKWWRJX09VS52MM0NJX85ZW';
    
    // The items inside the fulfillment are what we need to pass
    const query = container.resolve('query');
    const { data: [fulfillment] } = await query.graph({
        entity: 'fulfillment',
        fields: ['id', 'items.id', 'items.quantity', 'items.line_item_id'],
        filters: { id: fulfillmentId }
    });
    
    console.log("Found fulfillment items:", fulfillment.items);
    
    try {
        console.log("Attempting createOrderShipmentWorkflow...");
        await createOrderShipmentWorkflow(container).run({
            input: {
                order_id: orderId,
                fulfillment_id: fulfillmentId,
                items: fulfillment.items.map((i: any) => ({
                    id: i.line_item_id, // IT MUST BE THE ORDER ITEM ID
                    quantity: i.quantity
                }))
            }
        });
        console.log("createOrderShipmentWorkflow Success!");
    } catch(e: any) {
        console.error("createOrderShipmentWorkflow Error:", e.message);
    }
}
