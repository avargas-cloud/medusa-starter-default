import { initialize as initializeOrderModule } from "@medusajs/order"
import * as dotenv from 'dotenv';
dotenv.config({ path: 'backend/.env' });

async function run() {
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) {
        console.error("No DATABASE_URL found"); return;
    }

    try {
        const orderService = await initializeOrderModule({
            database: {
                clientUrl: dbUrl,
                driverOptions: { connection: { ssl: false } }
            }
        });

        const orders = await orderService.listOrders({}, {
            select: ["id", "display_id", "total", "subtotal"],
            relations: ["items"],
            take: 3,
            order: { created_at: "DESC" }
        });

        for (const order of orders) {
            console.log(`\n============================`);
            console.log(`ORDER ID:`, order.id);
            console.log(`Display ID:`, order.display_id);
            console.log(`Total:`, order.total);
            console.log(`Subtotal:`, order.subtotal);
            console.log(`Items count:`, order.items?.length);
            for (const item of order.items || []) {
                console.log(`  - Item Title:`, item.title);
                console.log(`  - Quantity:`, item.quantity);
                console.log(`  - Unit Price:`, item.unit_price);
            }
        }

    } catch (e) {
         console.error(e)
    }
}
run();
