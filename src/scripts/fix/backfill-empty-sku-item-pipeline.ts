/**
 * backfill-empty-sku-item-pipeline.ts
 *
 * Hydrates `qb_item_pipeline` rows with empty/missing `sku` by looking up the
 * SKU from `product_variant` via `variant_id`. The bug was in `sendToQbStep`
 * (now fixed): when admin updates omitted the SKU field, the pipeline row was
 * persisted with `""`, breaking the audit trail.
 *
 * Usage:
 *   cd backend
 *   yarn medusa exec ./src/scripts/fix/backfill-empty-sku-item-pipeline.ts
 */

import { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { QUICKBOOKS_CATALOG_MODULE } from "../../modules/quickbooks-catalog";

type PipelineRow = {
  id: string;
  variant_id: string;
  sku: string | null;
};

type VariantRow = {
  id: string;
  sku: string | null;
};

export default async function backfillEmptySkuItemPipeline({
  container,
}: {
  container: MedusaContainer;
}) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const catalog = container.resolve(QUICKBOOKS_CATALOG_MODULE) as any;

  const { data: rows } = await query.graph({
    entity: "qb_item_pipeline",
    fields: ["id", "variant_id", "sku"],
    pagination: { skip: 0, take: 10000 },
  });

  const empties = (rows as PipelineRow[]).filter(
    (r) => !r.sku || r.sku.trim() === ""
  );

  console.log(
    `\n[backfill-empty-sku-item-pipeline] scanned ${rows.length} rows, ${empties.length} with empty sku\n`
  );

  if (empties.length === 0) {
    console.log("Nothing to do — all rows have a sku.");
    return;
  }

  const variantIds = Array.from(new Set(empties.map((r) => r.variant_id)));
  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku"],
    filters: { id: variantIds },
    pagination: { skip: 0, take: variantIds.length },
  });
  const skuByVariant = new Map<string, string>(
    (variants as VariantRow[])
      .filter((v) => v.sku && v.sku.trim() !== "")
      .map((v) => [v.id, v.sku!.trim()])
  );

  let fixed = 0;
  let unresolved = 0;
  for (const row of empties) {
    const sku = skuByVariant.get(row.variant_id);
    if (!sku) {
      console.warn(
        `  SKIP ${row.id} — variant ${row.variant_id} has no sku either`
      );
      unresolved++;
      continue;
    }
    await catalog.updateQbItemPipelines({ id: row.id, sku });
    console.log(`  FIX  ${row.id} → "${sku}" (variant ${row.variant_id})`);
    fixed++;
  }

  console.log(
    `\n[backfill-empty-sku-item-pipeline] done — fixed=${fixed}, unresolved=${unresolved}\n`
  );
}
