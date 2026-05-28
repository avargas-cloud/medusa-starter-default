import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { deleteProductsWorkflow } from "@medusajs/medusa/core-flows";

/**
 * Cleanup de los test-products huérfanos (sin quickbooks_id, sin referencias).
 *
 * Borra SOLO los productos cuyas variantes tengan SKU en TARGET_SKUS y que NO
 * tengan quickbooks_id en metadata (guard de seguridad). Usa
 * deleteProductsWorkflow para que el cascade limpie variantes, opciones y
 * los links de inventory item.
 *
 * DRY_RUN (default true):
 *   DRY_RUN=true  yarn medusa exec src/scripts/fix/delete-orphan-test-products.ts
 *   DRY_RUN=false yarn medusa exec src/scripts/fix/delete-orphan-test-products.ts
 */

const TARGET_SKUS = ["test-product1", "test-product2"];

export default async function deleteOrphanTestProducts({ container }: ExecArgs) {
  const isDryRun = process.env.DRY_RUN !== "false";
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info(
    isDryRun ? "📋 DRY RUN — no se borrará nada" : "⚠️  EXECUTION MODE"
  );

  const { data: variants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "metadata", "product.id", "product.title", "product.status"],
    filters: { sku: TARGET_SKUS },
  });

  if (variants.length === 0) {
    logger.info("✅ No hay variantes que coincidan — nada que borrar.");
    return;
  }

  const productIds: string[] = [];
  for (const v of variants as any[]) {
    const qbId = v.metadata?.quickbooks_id;
    if (qbId) {
      logger.warn(`   ⏭️  SKIP ${v.sku}: tiene quickbooks_id=${qbId} (no se borra)`);
      continue;
    }
    if (!v.product?.id) {
      logger.warn(`   ⏭️  SKIP ${v.sku}: sin product asociado`);
      continue;
    }
    logger.info(
      `   🗑️  ${v.sku} → ${v.product.id} (${v.product.title}, status=${v.product.status})`
    );
    productIds.push(v.product.id);
  }

  if (productIds.length === 0) {
    logger.info("✅ Nada elegible para borrar tras los guards.");
    return;
  }

  if (isDryRun) {
    logger.info(`\n✅ DRY RUN: se borrarían ${productIds.length} productos.`);
    logger.info("   Para ejecutar: DRY_RUN=false yarn medusa exec src/scripts/fix/delete-orphan-test-products.ts");
    return;
  }

  await deleteProductsWorkflow(container).run({ input: { ids: productIds } });
  logger.info(`\n✅ Borrados ${productIds.length} productos: ${productIds.join(", ")}`);
}
