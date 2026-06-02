import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk";
import { MedusaContainer } from "@medusajs/framework/types";

import {
  createPosProductV2Workflow,
  CreatePosProductV2Input,
} from "../../workflows/pos/create-pos-product-v2";
import {
  ensureMiamiLevelsStep,
  EnsureMiamiLevelsInput,
} from "../../workflows/pos/steps/ensure-miami-levels-step";
import { USA_LOC } from "../../lib/locations";

const ensureMiamiLevelsSandboxWorkflow = createWorkflow(
  "sandbox-verify-ensure-miami-levels",
  function (input: EnsureMiamiLevelsInput) {
    const result = ensureMiamiLevelsStep(input);
    return new WorkflowResponse(result);
  }
);

type KnexLike = {
  raw: <T = { rows: unknown[] }>(sql: string, bindings?: unknown[]) => Promise<T>;
};

type ProductResult = {
  id: string;
  variants?: Array<{ id: string; sku: string }>;
};

type WorkflowResult = {
  product?: ProductResult;
  pipeline?: Array<{ status: string; sku: string; error?: string }>;
};

type CategoryRow = { id: string };
type VendorRow = { id: string; full_name: string | null; company_name: string | null };
type VariantCheckRow = {
  product_id: string;
  product_taxable: boolean;
  variant_id: string;
  sku: string;
  manage_inventory: boolean;
  inventory_item_id: string | null;
  miami_level_count: string | number;
};

const COGS_ACCT = "Purchases - Resale Items:Ecopowertech";
const INCOME_ACCT = "Sales:Ecopowertech:Ecopowertech - Others";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function cents(amount: number) {
  return Math.round(amount * 100) / 100;
}

async function fetchSetup(pg: KnexLike) {
  const category = await pg.raw<{ rows: CategoryRow[] }>(
    `SELECT id FROM product_category WHERE deleted_at IS NULL ORDER BY rank ASC NULLS LAST, id ASC LIMIT 1`
  );
  const vendor = await pg.raw<{ rows: VendorRow[] }>(
    `SELECT id, full_name, company_name FROM qb_vendor WHERE deleted_at IS NULL ORDER BY updated_at DESC NULLS LAST, id ASC LIMIT 1`
  );

  assert(category.rows[0]?.id, "No product_category found in sandbox");
  assert(vendor.rows[0]?.id, "No qb_vendor found in sandbox");

  return {
    categoryId: category.rows[0].id,
    vendorId: vendor.rows[0].id,
    vendorName:
      vendor.rows[0].full_name ?? vendor.rows[0].company_name ?? "Sandbox Vendor",
  };
}

function buildPayload(args: {
  stamp: string;
  label: string;
  itemType: "Inventory" | "Service";
  taxable: boolean;
  categoryId: string;
  vendorId: string;
  vendorName: string;
  variantSkus: string[];
}): CreatePosProductV2Input {
  return {
    item_type: args.itemType,
    title: `SANDBOX POS ${args.label} ${args.stamp}`,
    sales_description: `Sandbox POS product verification ${args.label}`,
    category_ids: [args.categoryId],
    cogs_account_full_name: args.itemType === "Inventory" ? COGS_ACCT : undefined,
    income_account_full_name: INCOME_ACCT,
    vendor_full_name: args.vendorName,
    vendor_qb_id: args.vendorId,
    taxable: args.taxable,
    variants: args.variantSkus.map((sku, index) => ({
      sku,
      title: sku,
      cost: cents(4 + index),
      retail_price: cents(11 + index),
      wholesale_price: cents(8 + index),
      sales_description: `Sandbox ${sku}`,
      options: args.variantSkus.length > 1 ? { Color: `Option ${index + 1}` } : {},
    })),
    product_attribute: undefined,
  };
}

async function runCreate(
  container: MedusaContainer,
  label: string,
  input: CreatePosProductV2Input
) {
  const { result, errors } = await createPosProductV2Workflow(container).run({
    input,
    throwOnError: false,
  });

  if (errors?.length) {
    throw new Error(`${label}: workflow errors ${JSON.stringify(errors)}`);
  }

  const payload = result as WorkflowResult;
  assert(payload.product?.id, `${label}: missing product id`);
  assert(
    payload.product.variants?.length === input.variants.length,
    `${label}: expected ${input.variants.length} variants, got ${payload.product.variants?.length ?? 0}`
  );

  return payload.product;
}

async function loadVariantChecks(pg: KnexLike, productId: string) {
  const result = await pg.raw<{ rows: VariantCheckRow[] }>(
    `SELECT
       p.id AS product_id,
       p.taxable AS product_taxable,
       pv.id AS variant_id,
       pv.sku,
       pv.manage_inventory,
       pvii.inventory_item_id,
       COUNT(il.id) FILTER (WHERE il.location_id = ?) AS miami_level_count
     FROM product p
     JOIN product_variant pv ON pv.product_id = p.id AND pv.deleted_at IS NULL
     LEFT JOIN product_variant_inventory_item pvii ON pvii.variant_id = pv.id AND pvii.deleted_at IS NULL
     LEFT JOIN inventory_level il ON il.inventory_item_id = pvii.inventory_item_id AND il.deleted_at IS NULL
     WHERE p.id = ? AND p.deleted_at IS NULL
     GROUP BY p.id, p.taxable, pv.id, pv.sku, pv.manage_inventory, pvii.inventory_item_id
     ORDER BY pv.sku`,
    [USA_LOC, productId]
  );

  return result.rows;
}

function checkInventoryRows(
  label: string,
  rows: VariantCheckRow[],
  expectedTaxable: boolean,
  expectedCount: number
) {
  assert(rows.length === expectedCount, `${label}: expected ${expectedCount} rows, got ${rows.length}`);
  for (const row of rows) {
    assert(row.product_taxable === expectedTaxable, `${label}: product.taxable mismatch for ${row.sku}`);
    assert(row.manage_inventory === true, `${label}: manage_inventory false for ${row.sku}`);
    assert(row.inventory_item_id, `${label}: missing inventory_item link for ${row.sku}`);
    assert(Number(row.miami_level_count) >= 1, `${label}: missing Miami inventory level for ${row.sku}`);
  }
}

function checkServiceRows(
  label: string,
  rows: VariantCheckRow[],
  expectedTaxable: boolean
) {
  assert(rows.length === 1, `${label}: expected 1 row, got ${rows.length}`);
  const row = rows[0];
  assert(row.product_taxable === expectedTaxable, `${label}: product.taxable mismatch`);
  assert(row.manage_inventory === false, `${label}: service should not manage inventory`);
  assert(!row.inventory_item_id, `${label}: service unexpectedly has inventory_item link`);
}

export default async function verifyPosProductV2Sandbox({
  container,
}: {
  container: MedusaContainer;
}) {
  if (process.env.ECOPOWERTECH_ENV !== "sandbox") {
    throw new Error("Refusing to run outside ECOPOWERTECH_ENV=sandbox");
  }

  const logger = container.resolve("logger") as { info: (msg: string) => void };
  const pg = container.resolve("__pg_connection__") as KnexLike;
  const setup = await fetchSetup(pg);
  const stamp = Date.now().toString(36).toUpperCase();

  const cases = [
    {
      label: "Inventory taxable",
      input: buildPayload({
        ...setup,
        stamp,
        label: "INV TAX",
        itemType: "Inventory",
        taxable: true,
        variantSkus: [`SBX-INV-TAX-${stamp}`],
      }),
      validate: (rows: VariantCheckRow[]) => checkInventoryRows("Inventory taxable", rows, true, 1),
    },
    {
      label: "Inventory non-taxable",
      input: buildPayload({
        ...setup,
        stamp,
        label: "INV NONTAX",
        itemType: "Inventory",
        taxable: false,
        variantSkus: [`SBX-INV-NONTAX-${stamp}`],
      }),
      validate: (rows: VariantCheckRow[]) => checkInventoryRows("Inventory non-taxable", rows, false, 1),
    },
    {
      label: "Inventory multi-variant taxable",
      input: buildPayload({
        ...setup,
        stamp,
        label: "INV MULTI",
        itemType: "Inventory",
        taxable: true,
        variantSkus: [`SBX-INV-MULTI-A-${stamp}`, `SBX-INV-MULTI-B-${stamp}`],
      }),
      validate: (rows: VariantCheckRow[]) => checkInventoryRows("Inventory multi-variant taxable", rows, true, 2),
    },
    {
      label: "Service non-taxable",
      input: buildPayload({
        ...setup,
        stamp,
        label: "SVC NONTAX",
        itemType: "Service",
        taxable: false,
        variantSkus: [`SBX-SVC-NONTAX-${stamp}`],
      }),
      validate: (rows: VariantCheckRow[]) => checkServiceRows("Service non-taxable", rows, false),
    },
  ];

  for (const testCase of cases) {
    logger.info(`\n[verify-pos-product-v2] ${testCase.label}`);
    const product = await runCreate(container, testCase.label, testCase.input);
    const rows = await loadVariantChecks(pg, product.id);
    testCase.validate(rows);
    logger.info(`[verify-pos-product-v2] PASS ${testCase.label}: ${product.id}`);
  }

  logger.info("\n[verify-pos-product-v2] Auto-heal missing inventory link");
  const serviceForHeal = await runCreate(
    container,
    "Auto-heal source service",
    buildPayload({
      ...setup,
      stamp,
      label: "AUTO HEAL",
      itemType: "Service",
      taxable: true,
      variantSkus: [`SBX-AUTO-HEAL-${stamp}`],
    })
  );

  await ensureMiamiLevelsSandboxWorkflow(container).run({
    input: { product_id: serviceForHeal.id, manage_inventory: true },
    throwOnError: true,
  });

  const healedRows = await loadVariantChecks(pg, serviceForHeal.id);
  checkInventoryRows("Auto-heal missing inventory link", healedRows, true, 1);
  logger.info(`[verify-pos-product-v2] PASS Auto-heal missing inventory link: ${serviceForHeal.id}`);

  logger.info("\n[verify-pos-product-v2] ALL CASES PASSED");
}
