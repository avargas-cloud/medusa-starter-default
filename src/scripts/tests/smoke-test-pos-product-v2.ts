import { MedusaContainer } from "@medusajs/framework/types";

import {
  createPosProductV2Workflow,
  CreatePosProductV2Input,
} from "../../workflows/pos/create-pos-product-v2";

const CATEGORY_ID = "pcat_UNCATEGORIZEDECO00001";
const COGS_ACCT = "Purchases - Resale Items:Ecopowertech";
const INCOME_ACCT = "Sales:Ecopowertech:Ecopowertech - Others";
const VENDOR_QB_ID = "qbvnd_01KPGGQBTH5QPS21D520X2FEYE";
const VENDOR_FULL_NAME = "Legrand";

const buildInventoryPayload = (): CreatePosProductV2Input => ({
  item_type: "Inventory",
  title: "TEST Product 3 - Inventory",
  sales_description: "Smoke test Inventory item. Safe to delete.",
  category_ids: [CATEGORY_ID],
  cogs_account_full_name: COGS_ACCT,
  income_account_full_name: INCOME_ACCT,
  vendor_full_name: VENDOR_FULL_NAME,
  vendor_qb_id: VENDOR_QB_ID,
  variants: [
    {
      sku: "test-product3",
      title: "test-product3",
      cost: 5.0,
      retail_price: 12.99,
      wholesale_price: 9.99,
      mpn: "TEST-MPN-001",
    },
  ],
});

const buildServicePayload = (): CreatePosProductV2Input => ({
  item_type: "Service",
  title: "TEST Product 4 - Service",
  sales_description: "Smoke test Service item. Safe to delete.",
  category_ids: [CATEGORY_ID],
  income_account_full_name: INCOME_ACCT,
  vendor_full_name: VENDOR_FULL_NAME,
  vendor_qb_id: VENDOR_QB_ID,
  variants: [
    {
      sku: "test-product4",
      title: "test-product4",
      cost: 0,
      retail_price: 50.0,
      wholesale_price: 40.0,
    },
  ],
});

export default async function smokeTestPosProductV2({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve("logger");

  const runOne = async (label: string, payload: CreatePosProductV2Input) => {
    logger.info(`\n=== ${label}: ${payload.variants[0].sku} (${payload.item_type}) ===`);
    const { result, errors } = await createPosProductV2Workflow(container).run({
      input: payload,
      throwOnError: false,
    });

    if (errors && errors.length > 0) {
      logger.error(`  ❌ errors: ${JSON.stringify(errors, null, 2)}`);
      return;
    }

    const product = (result as any)?.product;
    const pipeline = (result as any)?.pipeline ?? [];
    logger.info(`  ✅ product.id      = ${product?.id}`);
    logger.info(`  ✅ product.handle  = ${product?.handle}`);
    logger.info(`  ✅ variants        = ${product?.variants?.length ?? 0}`);
    for (const p of pipeline) {
      logger.info(
        `  → pipeline: sku=${p.sku} status=${p.status} op=${p.operation_id ?? "-"} ${
          p.error ? `err=${p.error}` : ""
        }`
      );
    }
  };

  await runOne("Test 1 — Inventory", buildInventoryPayload());
  await runOne("Test 2 — Service", buildServicePayload());

  logger.info("\n=== Smoke test complete ===");
  logger.info(
    "  Next: wait ~60s, then re-run `SELECT * FROM qb_item_pipeline WHERE sku ILIKE 'test-product%'` to see the poller resolve."
  );
}
