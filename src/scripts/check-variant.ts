import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

export default async function checkVariant({ container }: ExecArgs) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  
  const id = "variant_01KPE2XS845DK7M2HC8M3CPM80";
  logger.info(`Checking variant: ${id}`);
  
  try {
    const { data } = await query.graph({
      entity: "variant",
      fields: ["id", "sku", "title", "manage_inventory", "inventory_items.*", "inventory_items.inventory.*"],
      filters: { id } // Use id directly in Medusa v2 Graph Query filters? Actually in v2 it's just filters: { id }
    });
    
    logger.info(JSON.stringify(data, null, 2));
  } catch (error: any) {
    logger.error("Error querying: " + error.message);
  }
}
