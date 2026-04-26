import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import { fetchQbBulkItems } from "../lib/fetch-qb-bulk-items";

/**
 * Script para Consultar QuickBooks y Actualizar quickbooks_id
 *
 * Consulta directamente con QuickBooks a través del Bridge para obtener
 * los ListID (quickbooks_id) de los productos faltantes y actualizar
 * el metadata de las variantes en Medusa.
 *
 * MODO DRY-RUN (Por defecto):
 *   DRY_RUN=true yarn medusa exec src/scripts/qb_sync/core_jobs/fetch-missing-qb-ids.ts
 *
 * MODO EJECUCIÓN REAL:
 *   DRY_RUN=false yarn medusa exec src/scripts/qb_sync/core_jobs/fetch-missing-qb-ids.ts
 */

export default async function fetchMissingQbIds({ container }: ExecArgs) {
  const isDryRun = process.env.DRY_RUN !== "false";
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const productModule = container.resolve(Modules.PRODUCT);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  logger.info("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  logger.info(
    isDryRun
      ? "📋 DRY RUN MODE - No se modificará nada"
      : "⚠️  EXECUTION MODE ACTIVE"
  );
  logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  try {
    // Paso 1: Encontrar variantes sin quickbooks_id
    logger.info("🔍 Buscando variantes sin quickbooks_id...\n");

    const { data: allVariants } = await query.graph({
      entity: "variant",
      fields: ["id", "sku", "metadata"],
      filters: {},
    });

    const variantsWithoutQbId = allVariants.filter(
      (v: any) => v.sku && (!v.metadata || !v.metadata.quickbooks_id)
    );

    if (variantsWithoutQbId.length === 0) {
      logger.info("✅ Todas las variantes tienen quickbooks_id");
      return;
    }

    logger.info(
      `   ⚠️  Encontradas ${variantsWithoutQbId.length} variantes sin quickbooks_id:\n`
    );
    variantsWithoutQbId.slice(0, 10).forEach((v: any, idx: number) => {
      logger.info(`      ${idx + 1}. ${v.sku}`);
    });
    if (variantsWithoutQbId.length > 10) {
      logger.info(`      ... y ${variantsWithoutQbId.length - 10} más`);
    }

    // Paso 2: Consultar QuickBooks Bridge
    logger.info("\n📡 Consultando QuickBooks Bridge...\n");

    const { items: qbItems, totalFetched } = await fetchQbBulkItems({
      logger: (msg) => logger.info(`   ${msg}`),
    });
    logger.info(`   ✅ ${totalFetched} productos obtenidos de QuickBooks`);

    const qbData = qbItems.map((i) => ({
      ListID: i.ListID,
      Name: i.Name,
      MPN: i.ManufacturerPartNumber,
    }));

    // Paso 3 (obsoleto): el polling ahora lo maneja fetchQbBulkItems internamente.

    // Paso 4: Matching SKU con QuickBooks Name
    logger.info("\n🔄 Buscando coincidencias SKU ↔ QuickBooks...\n");

    const qbMap = new Map<string, any>();

    // Crear mapa Name -> QuickBooks Item
    qbData.forEach((item) => {
      if (item.Name) {
        qbMap.set(item.Name.toUpperCase(), item);
      }
    });

    const updates: Array<{ variant: any; qbItem: any }> = [];

    for (const variant of variantsWithoutQbId) {
      const sku = variant.sku?.toUpperCase();
      if (!sku) continue;
      let qbItem = qbMap.get(sku);

      if (qbItem) {
        updates.push({ variant, qbItem });
        logger.info(
          `   ✓ Match: ${variant.sku} ↔ ${qbItem.Name} (${qbItem.ListID})`
        );
      } else {
        logger.warn(`   ✗ No match: ${variant.sku}`);
      }
    }

    logger.info(`\n📊 Resumen de matches:`);
    logger.info(`   • Total sin QB ID: ${variantsWithoutQbId.length}`);
    logger.info(`   • Matches encontrados: ${updates.length}`);
    logger.info(
      `   • Sin match: ${variantsWithoutQbId.length - updates.length}`
    );

    if (updates.length === 0) {
      logger.info("\n⚠️  No se encontraron matches para actualizar");
      return;
    }

    // Paso 5: Actualizar metadata
    if (!isDryRun) {
      logger.info("\n🔄 Actualizando metadata...\n");

      for (const { variant, qbItem } of updates) {
        try {
          const newMetadata = {
            ...(variant.metadata || {}),
            quickbooks_id: qbItem.ListID,
          };

          // Agregar MPN si existe
          if (qbItem.MPN) {
            newMetadata.mpn = qbItem.MPN;
          }

          await productModule.updateProductVariants(variant.id, {
            metadata: newMetadata,
          });

          logger.info(
            `   ✅ ${variant.sku}: QB_ID=${qbItem.ListID}${qbItem.MPN ? `, MPN=${qbItem.MPN}` : ""}`
          );
        } catch (err: any) {
          logger.error(
            `   ❌ Error actualizando ${variant.sku}: ${err.message}`
          );
        }
      }

      logger.info("\n✅ Actualización completada");
    } else {
      logger.info("\n✅ DRY RUN COMPLETADO");
      logger.info("\n   Variantes que se actualizarían:\n");
      updates.forEach(({ variant, qbItem }) => {
        logger.info(
          `   • ${variant.sku} → QB_ID: ${qbItem.ListID}${qbItem.MPN ? `, MPN: ${qbItem.MPN}` : ""}`
        );
      });
      logger.info("\n   Para ejecutar:");
      logger.info(
        "   DRY_RUN=false npx medusa exec ./src/scripts/fetch-missing-qb-ids.ts"
      );
    }
  } catch (error: any) {
    logger.error(`\n❌ ERROR: ${error.message}`);
    throw error;
  }
}
