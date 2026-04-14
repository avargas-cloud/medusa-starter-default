import { initialize } from "@medusajs/framework/utils";

export default async function run() {
  console.log("Starting DB test...");
  try {
    const { query } = await initialize({});
    const apps = await query.graph({
      entity: "payment_application",
      fields: ["id", "amount_applied", "payment_id", "invoice_id"],
    });
    console.log("ALL APPLICATIONS:", JSON.stringify(apps.data, null, 2));
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
run();
