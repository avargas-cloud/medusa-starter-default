import { initialize as initializeOrderModule } from "@medusajs/order"
import dotenv from "dotenv"

dotenv.config()

async function run() {
    try {
        const orderService = await initializeOrderModule({
            database: {
                clientUrl: process.env.DATABASE_URL,
                driverOptions: {
                    connection: { ssl: false }
                }
            }
        })
        const order = await orderService.retrieveOrder("order_01KJ8NM22FMBXKD6Y111HAQ9JW", {
            select: ["id", "display_id", "total", "subtotal", "currency_code", "items.*"]
        })
        console.log("=== ORDER SERVICE RETURNED ===")
        console.dir(order, { depth: null })
    } catch (e) {
        console.error(e)
    }
}
run()
