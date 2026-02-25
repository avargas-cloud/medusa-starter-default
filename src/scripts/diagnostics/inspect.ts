import { Modules } from "@medusajs/framework/utils"
// @ts-ignore
import { initialize as initializeCartModule } from "@medusajs/cart"

async function run() {
  const cartModule = await initializeCartModule({
    database: {
      clientUrl: process.env.DATABASE_URL,
      driverOptions: { ssl: { rejectUnauthorized: false } }
    }
  })
  const items = await cartModule.listLineItems({}, { select: ["id", "quantity", "raw_quantity"] })
  console.log("Cart Line Item sample:", items[0])
}
run().then(() => process.exit(0))
