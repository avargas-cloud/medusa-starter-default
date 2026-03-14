import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    const MEDUSA_URL = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
    const PUBLISHABLE_KEY = process.env.PUBLISHABLE_API_KEY || "";
    
    const query = "?fields=*items,items.quantity,items.unit_price,items.title,total,subtotal";
    
    try {
        const response = await fetch(`${MEDUSA_URL}/store/orders${query}`, {
            headers: {
                'Content-Type': 'application/json',
                'x-publishable-api-key': PUBLISHABLE_KEY
            }
        });
        
        const data = await response.json();
        console.log(`STATUS:`, response.status);
        console.log(`TOTAL ORDERS:`, data.orders?.length || 0);
        
        if (data.orders && data.orders.length > 0) {
            const first = data.orders[0];
            console.log("\n--- LATEST ORDER ---")
            console.log("ID:", first.id)
            console.log("Total:", first.total)
            console.log("Subtotal:", first.subtotal)
            console.log("Items:", JSON.stringify(first.items, null, 2))
        } else {
            console.log("Response:", data)
        }
    } catch(e) {
        console.error("Fetch erred:", e);
    }
}
run();
