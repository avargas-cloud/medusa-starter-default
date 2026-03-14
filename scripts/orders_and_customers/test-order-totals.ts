import { initialize as initializeOrderModule } from "@medusajs/order"
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  try {
    const orderModule = await initializeOrderModule({
        clientUrl: process.env.DATABASE_URL.replace('?sslmode=require', ''),
        driverOptions: { connection: { ssl: { rejectUnauthorized: false } } },
    });
    
    console.log('Fetching order 1057 with items.quantity ...');
    const orders2 = await orderModule.listOrders({
        display_id: 1057
    }, {
        select: ['id', 'display_id', 'items.id', 'items.quantity', 'items.raw_quantity', 'items.unit_price', 'items.raw_unit_price']
    });
    console.log('ORDER 1057 ITEMS:', JSON.stringify(orders2[0]?.items, null, 2));
  } catch (e) {
    console.error(e);
  }
}
run();
