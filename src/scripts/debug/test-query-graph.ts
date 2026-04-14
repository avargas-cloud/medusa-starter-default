import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

export default async function myScript({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: ["id", "inventory_items.inventory_item_id"],
    filters: { id: "variant_01KFRNPMS8K91A2HQ49W5JRB88" }, // ESPFC4R4N50W0830
  });
  console.log(JSON.stringify(variants, null, 2));
}
