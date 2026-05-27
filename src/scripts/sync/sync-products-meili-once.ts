import { ExecArgs } from "@medusajs/framework/types";
import { syncProductsWorkflow } from "../../workflows/sync-products";

export default async function ({ container }: ExecArgs) {
  console.log("Force syncing all products to MeiliSearch...");
  const { result } = await syncProductsWorkflow(container).run({ input: {} });
  console.log(
    `Done. synced=${result.synced} orphansDeleted=${result.orphansDeleted} totalInIndex=${result.totalInIndex} durationMs=${result.durationMs}`
  );
}
