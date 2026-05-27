import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { IProductModuleService } from "@medusajs/types";

const PRODUCT_ID = "prod_01KK5CFJVG1BJVPQKR0H12EDVN";

const VARIANTS = [
  {
    sku: "ESP-NFA30W0430",
    title: "3000K",
    optionValue: "3000K",
    inventoryItemId: "iitem_01KK5FCTNADSJ9HBXM17XTFHKT",
    variantRank: 0,
    salesDescription:
      "LED Freecut SOB Strip, 24VDC, 320LED/Meter, 30W/Roll, 6W/Meter, 1.83W/Ft, 329 LM/ft, 3000K, 4mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends  (black cable, dotted cable is negative).. 5 year warranty.",
  },
  {
    sku: "ESP-NFA30W0440",
    title: "4000K",
    optionValue: "4000K",
    inventoryItemId: "iitem_01KK5FCPHXWY9T4HR54EDDW19F",
    variantRank: 1,
    salesDescription:
      "LED Freecut SOB Strip, 24VDC, 320LED/Meter, 30W/Roll, 6W/Meter, 1.83W/Ft, 329 LM/ft, 4000K, 4mm, White Board, IP20, UL Listed, 5 meters/16.4 feet. 6ft 24V 3A Dupont Male Connector on both ends  (black cable, dotted cable is negative).. 5 year warranty.",
  },
];

export default async function ({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule = container.resolve(Modules.PRODUCT) as IProductModuleService;
  const link = container.resolve(ContainerRegistrationKeys.LINK);

  for (const cfg of VARIANTS) {
    logger.info(`Creating ${cfg.sku} (${cfg.title})...`);
    const [created] = await productModule.createProductVariants([
      {
        product_id: PRODUCT_ID,
        title: cfg.title,
        sku: cfg.sku,
        variant_rank: cfg.variantRank,
        manage_inventory: false,
        allow_backorder: false,
        options: { "Color Options": cfg.optionValue },
        metadata: {
          sales_description: cfg.salesDescription,
        },
      } as Parameters<typeof productModule.createProductVariants>[0][0],
    ]);
    const variantId = (created as { id: string }).id;
    logger.info(`  variant created: ${variantId}`);

    await productModule.updateProductVariants(variantId, {
      manage_inventory: true,
    });
    logger.info(`  manage_inventory re-enabled`);

    await link.create({
      [Modules.PRODUCT]: { variant_id: variantId },
      [Modules.INVENTORY]: { inventory_item_id: cfg.inventoryItemId },
    });
    logger.info(`  linked to ${cfg.inventoryItemId}`);
  }

  logger.info("Done.");
}
