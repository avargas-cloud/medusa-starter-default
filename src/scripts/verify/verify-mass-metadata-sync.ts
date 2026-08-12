/**
 * verify-mass-metadata-sync.ts
 *
 * Static verifier for the mass QB metadata sync diff engine. Runs 25+ synthetic
 * scenarios against classifyMetadataDiff() and the payload builder — NO bridge,
 * NO DB, NO writes. Guarantees the engine behaves correctly before any apply run.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/verify/verify-mass-metadata-sync.ts
 */

import type { MedusaContainer } from "@medusajs/framework/types";
import {
  classifyMetadataDiff,
  computeProposedDefaults,
  type Classification,
  type ClassifyInput,
} from "../../scripts/qb_sync/lib/classify-metadata-diff";
import {
  emptyPayloadMap,
  mergeProductDiff,
  mergeVariantDiff,
} from "../../scripts/qb_sync/lib/build-update-payload";
import type {
  MedusaProductView,
  MedusaVariantView,
  QbItemSnapshot,
} from "../../lib/quickbooks/bulk-item-types";

function snap(overrides: Partial<QbItemSnapshot>): QbItemSnapshot {
  return {
    listId: "QB-001",
    editSequence: "1",
    sku: "SKU-001",
    isActive: true,
    mpn: undefined,
    salesDesc: undefined,
    purchaseDesc: undefined,
    purchaseCost: undefined,
    avgCost: undefined,
    incomeAccountFullName: undefined,
    cogsAccountFullName: undefined,
    vendorFullName: undefined,
    vendorListId: undefined,
    itemType: "Inventory",
    ...overrides,
  };
}

function variant(
  id: string,
  productId: string,
  metadata: Record<string, unknown> | null,
): MedusaVariantView {
  return { id, productId, sku: null, metadata };
}

function product(
  id: string,
  metadata: Record<string, unknown> | null,
): MedusaProductView {
  return { id, metadata };
}

interface Case {
  label: string;
  group: string;
  input: ClassifyInput;
  expectClassification: Classification;
  expectProductDiffKeys?: string[];
  expectVariantDiffKeys?: string[];
  expectClearingKeys?: string[];
}

const CASES: Case[] = [
  // ── FULL MATCH ──────────────────────────────────────────────────────────
  {
    label: "All fields match — NO_CHANGE",
    group: "full-match",
    input: {
      qb: snap({
        incomeAccountFullName: "Sales",
        cogsAccountFullName: "COGS",
        vendorFullName: "Acme",
        vendorListId: "V-1",
        purchaseCost: 120,
        mpn: "MPN-001",
        salesDesc: "desc",
      }),
      variant: variant("v1", "p1", {
        quickbooks_id: "QB-001",
        qb_sku: "SKU-001",
        qb_edit_sequence: "1",
        qb_is_active: true,
        purchase_cost: 120,
        mpn: "MPN-001",
        sales_description: "desc",
      }),
      // "Todo coincide" incluye el par de vendor con SUS DOS nombres: desde el
      // rename del 2026-08-12 un producto que sólo tenga los legacy tiene algo
      // que escribir (el sync se auto-cura), así que un fixture legacy-only
      // clasifica PRODUCT_UPDATE — correcto, pero no es este caso.
      product: product("p1", {
        qb_income_account_full_name: "Sales",
        qb_cogs_account_full_name: "COGS",
        vendor_full_name: "Acme",
        vendor_list_id: "V-1",
        qb_vendor_full_name: "Acme",
        qb_vendor_list_id: "V-1",
        qb_item_type: "Inventory",
      }),
      isDriver: true,
    },
    expectClassification: "NO_CHANGE",
  },

  // ── VARIANT-ONLY CHANGES ────────────────────────────────────────────────
  {
    label: "PurchaseCost changed — VARIANT_UPDATE",
    group: "variant-only",
    input: {
      qb: snap({ purchaseCost: 125 }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, purchase_cost: 120 }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["purchase_cost"],
  },
  {
    label: "PurchaseCost 0 — writes 0 (QB is source of truth)",
    group: "variant-only",
    input: {
      qb: snap({ purchaseCost: 0 }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, purchase_cost: 120 }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["purchase_cost"],
  },
  {
    label: "PurchaseCost undefined (Service item) — no diff even if Medusa has value",
    group: "variant-only",
    input: {
      qb: snap({ itemType: "Service", purchaseCost: undefined }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, purchase_cost: 120 }),
      product: product("p1", { qb_item_type: "Service" }),
      isDriver: true,
    },
    expectClassification: "NO_CHANGE",
  },
  {
    label: "sales_description changed — VARIANT_UPDATE",
    group: "variant-only",
    input: {
      qb: snap({ salesDesc: "New desc" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, sales_description: "Old desc" }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["sales_description"],
  },
  {
    label: "mpn changed — VARIANT_UPDATE",
    group: "variant-only",
    input: {
      qb: snap({ mpn: "MPN-NEW" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, mpn: "MPN-OLD" }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["mpn"],
  },
  {
    label: "EditSequence bumped — VARIANT_UPDATE",
    group: "variant-only",
    input: {
      qb: snap({ editSequence: "5" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["qb_edit_sequence"],
  },
  {
    label: "IsActive flipped false→true — VARIANT_UPDATE",
    group: "variant-only",
    input: {
      qb: snap({ isActive: true }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: false }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["qb_is_active"],
  },
  {
    label: "quickbooks_id link missing in Medusa — VARIANT_UPDATE (repair)",
    group: "variant-only",
    input: {
      qb: snap({}),
      variant: variant("v1", "p1", { qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["quickbooks_id"],
  },
  {
    label: "PurchaseCost '120.0000' vs 120 — numeric-equal, NO_CHANGE",
    group: "variant-only",
    input: {
      qb: snap({ purchaseCost: 120 }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, purchase_cost: "120.0000" }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "NO_CHANGE",
  },

  // ── PRODUCT-LEVEL (DRIVER) ──────────────────────────────────────────────
  {
    label: "Driver: IncomeAccountRef changed — PRODUCT_UPDATE",
    group: "product-driver",
    input: {
      qb: snap({ incomeAccountFullName: "Sales-New" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_income_account_full_name: "Sales-Old", qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "PRODUCT_UPDATE",
    expectProductDiffKeys: ["qb_income_account_full_name"],
  },
  {
    label: "Driver: Vendor changed — PRODUCT_UPDATE (name + list_id)",
    group: "product-driver",
    input: {
      qb: snap({ vendorFullName: "Beta Co", vendorListId: "V-2" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_vendor_full_name: "Acme", qb_vendor_list_id: "V-1", qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "PRODUCT_UPDATE",
    // Four keys: the renamed pair and its legacy alias move together. These
    // fixtures carry only the legacy names, so the renamed ones are written
    // from null — the sync self-heals a product the migration hasn't reached.
    expectProductDiffKeys: [
      "vendor_full_name",
      "qb_vendor_full_name",
      "vendor_list_id",
      "qb_vendor_list_id",
    ],
  },
  {
    label: "Driver: Vendor undefined (not reported by QB) — no product change",
    group: "product-driver",
    input: {
      qb: snap({ vendorFullName: undefined, vendorListId: undefined }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_vendor_full_name: "Acme", qb_vendor_list_id: "V-1", qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "NO_CHANGE",
  },
  {
    label: "Driver: itemType changed Inventory→Service — PRODUCT_UPDATE",
    group: "product-driver",
    input: {
      qb: snap({ itemType: "Service" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "PRODUCT_UPDATE",
    expectProductDiffKeys: ["qb_item_type"],
  },

  // ── OVERRIDES (NON-DRIVER) ──────────────────────────────────────────────
  {
    label: "Non-driver: QB vendor differs from product default — sets override",
    group: "override",
    input: {
      qb: snap({ vendorFullName: "Beta Co", vendorListId: "V-2" }),
      variant: variant("v2", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_vendor_full_name: "Acme", qb_vendor_list_id: "V-1", qb_item_type: "Inventory" }),
      isDriver: false,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["qb_override_vendor_full_name", "qb_override_vendor_qb_id"],
  },
  {
    label: "Non-driver: QB vendor matches product default — NO_CHANGE (no override needed)",
    group: "override",
    input: {
      qb: snap({ vendorFullName: "Acme", vendorListId: "V-1" }),
      variant: variant("v2", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_vendor_full_name: "Acme", qb_vendor_list_id: "V-1", qb_item_type: "Inventory" }),
      isDriver: false,
    },
    expectClassification: "NO_CHANGE",
  },
  {
    label: "Non-driver: existing override now matches default — OVERRIDE_CLEARED",
    group: "override",
    input: {
      qb: snap({ vendorFullName: "Acme", vendorListId: "V-1" }),
      variant: variant("v2", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, qb_override_vendor_full_name: "Beta Co", qb_override_vendor_qb_id: "V-2" }),
      product: product("p1", { qb_vendor_full_name: "Acme", qb_vendor_list_id: "V-1", qb_item_type: "Inventory" }),
      isDriver: false,
    },
    expectClassification: "OVERRIDE_CLEARED",
    expectClearingKeys: ["qb_override_vendor_full_name", "qb_override_vendor_qb_id"],
  },
  {
    label: "Non-driver: income differs, vendor matches — sets only income override",
    group: "override",
    input: {
      qb: snap({ incomeAccountFullName: "Sales-Alt", vendorFullName: "Acme", vendorListId: "V-1" }),
      variant: variant("v2", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_income_account_full_name: "Sales", qb_vendor_full_name: "Acme", qb_vendor_list_id: "V-1", qb_item_type: "Inventory" }),
      isDriver: false,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["qb_override_income_account"],
  },

  // ── COMBO ───────────────────────────────────────────────────────────────
  {
    label: "Driver: product + variant changes — BOTH_UPDATE",
    group: "combo",
    input: {
      qb: snap({ incomeAccountFullName: "Sales-New", purchaseCost: 200 }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, purchase_cost: 100 }),
      product: product("p1", { qb_income_account_full_name: "Sales-Old", qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "BOTH_UPDATE",
    expectProductDiffKeys: ["qb_income_account_full_name"],
    expectVariantDiffKeys: ["purchase_cost"],
  },
  {
    label: "Mixed: variant field change + override clearing — VARIANT_UPDATE (not OVERRIDE_CLEARED)",
    group: "combo",
    input: {
      qb: snap({ vendorFullName: "Acme", vendorListId: "V-1", purchaseCost: 175 }),
      variant: variant("v2", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, purchase_cost: 150, qb_override_vendor_full_name: "Beta Co" }),
      product: product("p1", { qb_vendor_full_name: "Acme", qb_vendor_list_id: "V-1", qb_item_type: "Inventory" }),
      isDriver: false,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["purchase_cost", "qb_override_vendor_full_name"],
  },

  // ── FIELD ABSENCE (conservative) ────────────────────────────────────────
  {
    label: "All optional fields undefined — NO_CHANGE (no signal = no touch)",
    group: "absence",
    input: {
      qb: snap({}),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, purchase_cost: 999, mpn: "old" }),
      product: product("p1", { qb_item_type: "Inventory", qb_vendor_full_name: "Acme" }),
      isDriver: true,
    },
    expectClassification: "NO_CHANGE",
  },
  {
    label: "QB reports empty SalesDesc (null, not undefined) — clears it on variant",
    group: "absence",
    input: {
      qb: snap({ salesDesc: null }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true, sales_description: "stale" }),
      product: product("p1", { qb_item_type: "Inventory" }),
      isDriver: true,
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["sales_description"],
  },
  // ── TWO-PASS (bug fix 2026-04-20): sibling uses driver's PROPOSED defaults ──
  {
    label: "Two-pass: sibling matches driver's proposed vendor (product was null) — NO override",
    group: "two-pass",
    input: {
      qb: snap({ vendorFullName: "Acme", vendorListId: "V-1", incomeAccountFullName: "Sales", cogsAccountFullName: "COGS" }),
      variant: variant("v2", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      // Product was unwritten before this run.
      product: product("p1", {}),
      isDriver: false,
      proposedDefaults: {
        income: "Sales",
        cogs: "COGS",
        vendorName: "Acme",
        vendorListId: "V-1",
        itemType: "Inventory",
      },
    },
    expectClassification: "NO_CHANGE",
  },
  {
    label: "Two-pass: sibling differs from driver's proposed vendor — sets overrides",
    group: "two-pass",
    input: {
      qb: snap({ vendorFullName: "Beta Co", vendorListId: "V-2" }),
      variant: variant("v2", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", {}),
      isDriver: false,
      proposedDefaults: {
        income: null,
        cogs: null,
        vendorName: "Acme",
        vendorListId: "V-1",
        itemType: "Inventory",
      },
    },
    expectClassification: "VARIANT_UPDATE",
    expectVariantDiffKeys: ["qb_override_vendor_full_name", "qb_override_vendor_qb_id"],
  },
  {
    label: "computeProposedDefaults: driver QB null merges with current product.metadata",
    group: "two-pass",
    input: {
      qb: snap({ incomeAccountFullName: undefined, vendorFullName: "NewVendor", vendorListId: "V-9" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", { qb_income_account_full_name: "ExistingIncome", qb_vendor_full_name: "OldVendor", qb_vendor_list_id: "V-8", qb_item_type: "Inventory" }),
      isDriver: true,
    },
    // Driver reports new vendor but not income → income stays, vendor changes.
    expectClassification: "PRODUCT_UPDATE",
    // Four keys: the renamed pair and its legacy alias move together. These
    // fixtures carry only the legacy names, so the renamed ones are written
    // from null — the sync self-heals a product the migration hasn't reached.
    expectProductDiffKeys: [
      "vendor_full_name",
      "qb_vendor_full_name",
      "vendor_list_id",
      "qb_vendor_list_id",
    ],
  },
  {
    // A product already carrying BOTH names, agreeing with QB, must stay
    // untouched. Without this the expand would look "safe" only because every
    // other fixture is mid-rename — this is the steady state after the
    // migration, and the one that must not churn 2.208 products.
    label: "Rename: both names present and matching QB — NO_CHANGE",
    group: "product-driver",
    input: {
      qb: snap({ vendorFullName: "Acme", vendorListId: "V-1" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", {
        vendor_full_name: "Acme",
        vendor_list_id: "V-1",
        qb_vendor_full_name: "Acme",
        qb_vendor_list_id: "V-1",
        qb_item_type: "Inventory",
      }),
      isDriver: true,
    },
    expectClassification: "NO_CHANGE",
  },
  {
    // The renamed key WINS over a stale legacy one — reading the legacy name
    // first is the class of bug this rename exists to prevent. Only the legacy
    // aliases move here, re-aligned to the renamed value.
    label: "Rename: renamed key wins over a stale legacy key",
    group: "product-driver",
    input: {
      qb: snap({ vendorFullName: "Acme", vendorListId: "V-1" }),
      variant: variant("v1", "p1", { quickbooks_id: "QB-001", qb_sku: "SKU-001", qb_edit_sequence: "1", qb_is_active: true }),
      product: product("p1", {
        vendor_full_name: "Acme",
        vendor_list_id: "V-1",
        qb_vendor_full_name: "Stale Legacy Vendor",
        qb_vendor_list_id: "V-STALE",
        qb_item_type: "Inventory",
      }),
      isDriver: true,
    },
    expectClassification: "PRODUCT_UPDATE",
    expectProductDiffKeys: ["qb_vendor_full_name", "qb_vendor_list_id"],
  },
];

function runClassifier(): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  const groups = new Map<string, Case[]>();
  for (const c of CASES) {
    const list = groups.get(c.group) ?? [];
    list.push(c);
    groups.set(c.group, list);
  }
  for (const [group, cases] of groups.entries()) {
    console.log(`── ${group.toUpperCase()} ──`);
    for (const c of cases) {
      const result = classifyMetadataDiff(c.input);
      const errors: string[] = [];
      if (result.classification !== c.expectClassification) {
        errors.push(`classification ${result.classification} != ${c.expectClassification}`);
      }
      if (c.expectProductDiffKeys) {
        const keys = result.productDiffs.map((d) => d.key).sort();
        const expected = [...c.expectProductDiffKeys].sort();
        if (JSON.stringify(keys) !== JSON.stringify(expected)) {
          errors.push(`productDiffs ${JSON.stringify(keys)} != ${JSON.stringify(expected)}`);
        }
      }
      if (c.expectVariantDiffKeys) {
        const keys = result.variantDiffs.map((d) => d.key).sort();
        const expected = [...c.expectVariantDiffKeys].sort();
        if (JSON.stringify(keys) !== JSON.stringify(expected)) {
          errors.push(`variantDiffs ${JSON.stringify(keys)} != ${JSON.stringify(expected)}`);
        }
      }
      if (c.expectClearingKeys) {
        const keys = result.variantDiffs.filter((d) => d.clearing).map((d) => d.key).sort();
        const expected = [...c.expectClearingKeys].sort();
        if (JSON.stringify(keys) !== JSON.stringify(expected)) {
          errors.push(`clearing ${JSON.stringify(keys)} != ${JSON.stringify(expected)}`);
        }
      }
      if (errors.length === 0) {
        pass++;
        console.log(`  OK   ${c.label}`);
      } else {
        fail++;
        console.log(`  FAIL ${c.label}`);
        for (const err of errors) console.log(`       ${err}`);
      }
    }
  }
  return { pass, fail };
}

function runPayloadBuilder(): { pass: number; fail: number } {
  console.log(`── PAYLOAD-BUILDER ──`);
  let pass = 0;
  let fail = 0;

  const map = emptyPayloadMap();
  const v = variant("v1", "p1", {
    qb_price_level: "wholesale_2024",
    shipping_attrs_weight_lbs: 5,
    purchase_cost: 100,
  });
  mergeVariantDiff(map, v, [
    { key: "purchase_cost", oldValue: 100, newValue: 125, clearing: false },
  ]);
  const patched = map.variants.get("v1")?.metadata ?? {};
  if (patched.qb_price_level === "wholesale_2024" && patched.shipping_attrs_weight_lbs === 5 && patched.purchase_cost === 125) {
    pass++;
    console.log(`  OK   foreign metadata preserved; target key overwritten`);
  } else {
    fail++;
    console.log(`  FAIL foreign metadata corrupted: ${JSON.stringify(patched)}`);
  }

  const map2 = emptyPayloadMap();
  const v2 = variant("v2", "p1", {
    qb_override_vendor_full_name: "Beta Co",
    qb_override_vendor_qb_id: "V-2",
    qb_price_level: "retail",
  });
  mergeVariantDiff(map2, v2, [
    { key: "qb_override_vendor_full_name", oldValue: "Beta Co", newValue: null, clearing: true },
    { key: "qb_override_vendor_qb_id", oldValue: "V-2", newValue: null, clearing: true },
  ]);
  const cleared = map2.variants.get("v2")?.metadata ?? {};
  if (!("qb_override_vendor_full_name" in cleared) && !("qb_override_vendor_qb_id" in cleared) && cleared.qb_price_level === "retail") {
    pass++;
    console.log(`  OK   clearing deletes keys entirely (not set to null)`);
  } else {
    fail++;
    console.log(`  FAIL clearing did not delete keys: ${JSON.stringify(cleared)}`);
  }

  const map3 = emptyPayloadMap();
  const p = product("p1", { foreign_key: "keep_me" });
  mergeProductDiff(map3, p, [
    { key: "qb_income_account_full_name", oldValue: null, newValue: "Sales" },
  ]);
  mergeProductDiff(map3, p, [
    { key: "qb_cogs_account_full_name", oldValue: null, newValue: "COGS" },
  ]);
  const merged = map3.products.get("p1")?.metadata ?? {};
  if (merged.foreign_key === "keep_me" && merged.qb_income_account_full_name === "Sales" && merged.qb_cogs_account_full_name === "COGS") {
    pass++;
    console.log(`  OK   sibling merges converge (income + cogs on same product)`);
  } else {
    fail++;
    console.log(`  FAIL sibling merge dropped keys: ${JSON.stringify(merged)}`);
  }

  return { pass, fail };
}

export default async function main(_container: MedusaContainer) {
  console.log(`\n══ verify-mass-metadata-sync ══\n`);
  const cls = runClassifier();
  console.log();
  const pay = runPayloadBuilder();
  console.log();
  const total = cls.pass + cls.fail + pay.pass + pay.fail;
  const pass = cls.pass + pay.pass;
  const fail = cls.fail + pay.fail;
  console.log(`Total: ${total}  Passed: ${pass}  Failed: ${fail}`);
  if (fail > 0) process.exitCode = 1;
}
