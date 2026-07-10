import { ExecArgs } from "@medusajs/framework/types";
import { IProductModuleService } from "@medusajs/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

/**
 * create-shipping-adjustment-product.ts
 *
 * Creates the Medusa product/variant for the "Shipping Adjustment" QB
 * OtherCharge item — used by DispatchModal's "Charge Additional Shipping" /
 * "Issue Shipping Credit" buttons instead of a freeform (variantId-less)
 * line. A freeform line only works for credit memos (pos_credit_memo_item
 * allows a null variant_id and the QB handler falls back to name-matching);
 * on a regular ORDER, `order-flow-core.ts` does `item.variant!.metadata!
 * .quickbooks_id` with a non-null assertion and CRASHES on a variant-less
 * line. Giving this a real variant with `quickbooks_id` set sidesteps that
 * entirely — both flows (new order AND quick credit) use the exact same
 * catalog item, syncing via the stable QB ListID instead of name-matching.
 *
 * QB data (confirmed via /admin/quickbooks/lookup, 2026-07-10):
 *   - QB FullName: SHIPPING & HANDLING:SHIPPING-ADJUSTMENT (sub-item)
 *   - QB Name:     SHIPPING-ADJUSTMENT  (the leaf name — used as our SKU)
 *   - QB Type:     ItemOtherChargeRet
 *   - QB ListID:   80001C46-1783723484
 *   - IsActive:    true
 *
 * "OtherCharge" is in NON_SITE_QB_ITEM_TYPES (order-flow-core.ts) so the
 * line automatically gets noSite:true (no <InventorySiteRef>, avoids QB
 * error 3140) and non-taxable — no extra flags needed, but we set the
 * legacy quickbooks_is_service/quickbooks_no_site flags too for parity with
 * the "Adjustement" precedent (belt-and-suspenders, cheap to keep in sync).
 *
 * Usage:
 *   npx medusa exec ./src/scripts/qb_sync/core_jobs/create-shipping-adjustment-product.ts
 */

const QB_LIST_ID = "80001C46-1783723484";
const QB_FULL_NAME = "SHIPPING & HANDLING:SHIPPING-ADJUSTMENT";
const SKU = "SHIPPING-ADJUSTMENT";
const TITLE = "Shipping Adjustment";

export default async function createShippingAdjustmentProduct({
  container,
}: ExecArgs) {
  const logger = container.resolve("logger");
  const productModule: IProductModuleService = container.resolve(
    Modules.PRODUCT
  );

  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data: existing } = await query.graph({
    entity: "variant",
    fields: ["id", "sku"],
    filters: { sku: SKU },
  });
  if (existing.length > 0) {
    logger.info(`✅ Variant with SKU "${SKU}" already exists (${existing[0].id}). Nothing to do.`);
    return;
  }

  logger.info("═".repeat(60));
  logger.info(`📦 Creating QB OtherCharge item in Medusa: "${TITLE}"`);
  logger.info(`   QB FullName: ${QB_FULL_NAME}`);
  logger.info(`   QB ListID:   ${QB_LIST_ID}`);
  logger.info("═".repeat(60));

  const [created] = await productModule.createProducts([
    {
      title: TITLE,
      handle: "shipping-adjustment",
      status: "published" as const,
      metadata: {
        sales_description:
          "Shipping method adjustment — additional charge or credit for a shipping method change after invoicing",
        qb_item_type: "OtherCharge",
        qb_imported: true,
        qb_import_date: new Date().toISOString().slice(0, 10),
        qb_import_source: "create-shipping-adjustment-product",
      },
      variants: [
        {
          title: "Default",
          sku: SKU,
          manage_inventory: false,
          allow_backorder: true,
          prices: [],
          metadata: {
            quickbooks_id: QB_LIST_ID,
            qb_sku: SKU,
            qb_full_name: QB_FULL_NAME,
            qb_item_type: "OtherCharge",
            quickbooks_is_service: true,
            quickbooks_no_site: true,
          },
        },
      ],
    } as Parameters<typeof productModule.createProducts>[0][0],
  ]);

  const productId = (created as { id: string }).id;
  logger.info(`\n✅ Created Medusa product: ${productId}`);
  logger.info(`   Title:   ${TITLE}`);
  logger.info(`   SKU:     ${SKU}`);
  logger.info(`   QB ID:   ${QB_LIST_ID}`);
  logger.info(`   Status:  published`);
  logger.info(`\n   Review at Admin → /app/products/${productId}`);
}
