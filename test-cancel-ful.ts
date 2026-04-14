import { cancelOrderFulfillmentWorkflow } from "@medusajs/core-flows";
import { initialize } from "@medusajs/framework";
import { config } from "dotenv";

config();

async function main() {
  const { app, container } = await initialize({
    projectConfig: {
      databaseUrl: process.env.DATABASE_URL,
    },
  });

  // We need a specific order and fulfillment ID.
  console.log("Ready to cancel.");
  process.exit(0);
}
main();
