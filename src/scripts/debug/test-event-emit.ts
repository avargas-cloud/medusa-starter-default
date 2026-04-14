import { MedusaApp } from "@medusajs/modules-sdk";
import { Modules } from "@medusajs/utils";
// Use the core test/debug approach in Medusa v2
import { initialize as initFinance } from "../modules/finance";
import { resolve } from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: resolve(__dirname, "../../.env") });

async function main() {
  console.log("Initializing Medusa modules...");
  const { modules } = await MedusaApp({
    sharedResourcesConfig: {
      database: {
        clientUrl: process.env.DATABASE_URL,
      },
    },
    modulesConfig: {
      [Modules.EVENT_BUS]: {
        resolve: "@medusajs/event-bus-redis",
        options: {
          redisUrl: process.env.REDIS_URL,
        },
      },
    },
  });

  const eventBus = modules[Modules.EVENT_BUS] as any;
  if (!eventBus) {
    console.error("Event bus not available");
    return;
  }

  console.log("Emitting pos.payment.created event...");
  await eventBus.emit([
    {
      name: "pos.payment.created",
      data: { id: "test_payment_123" },
    },
  ]);

  console.log("Emitted! Wait 2 seconds for subscriber to process...");
  await new Promise((r) => setTimeout(r, 2000));
  console.log("Done");
  process.exit(0);
}

main().catch(console.error);
