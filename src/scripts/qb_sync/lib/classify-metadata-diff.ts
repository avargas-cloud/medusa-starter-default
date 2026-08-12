/**
 * Pure diff engine for the mass QB metadata sync.
 *
 * Given (qb snapshot, Medusa variant, Medusa product, isDriver) this returns:
 *   - classification label
 *   - list of product-scope field diffs (only populated when isDriver)
 *   - list of variant-scope field diffs (direct fields + override set/clear)
 *
 * Pure function: no IO, no workflow calls. Unit-testable in isolation.
 */
import type {
  MedusaProductView,
  MedusaVariantView,
  ProductMetaKey,
  QbItemSnapshot,
  VariantMetaKey,
} from "../../../lib/quickbooks/bulk-item-types";
import {
  readVendorFullName,
  readVendorListId,
} from "../../../lib/vendor-metadata/keys";

export type Classification =
  | "NO_CHANGE"
  | "VARIANT_UPDATE"
  | "PRODUCT_UPDATE"
  | "BOTH_UPDATE"
  | "OVERRIDE_CLEARED"
  | "MISSING_IN_MEDUSA"
  | "ORPHAN_IN_MEDUSA";

export type DiffValue = string | number | boolean | null;

export type ProductFieldDiff = {
  key: ProductMetaKey;
  oldValue: DiffValue;
  newValue: DiffValue;
};

export type VariantFieldDiff = {
  key: VariantMetaKey;
  oldValue: DiffValue;
  newValue: DiffValue;
  clearing: boolean;
};

/**
 * Proposed product-level defaults computed from the driver's QB snapshot
 * during a first pass. Siblings use these (not the stale product.metadata)
 * so overrides are emitted only when they genuinely differ from the NEW
 * defaults the driver will write.
 */
export type ProposedProductDefaults = {
  income: string | null;
  cogs: string | null;
  vendorName: string | null;
  vendorListId: string | null;
  itemType: string | null;
};

export type ClassifyInput = {
  qb: QbItemSnapshot;
  variant: MedusaVariantView;
  product: MedusaProductView;
  // The driver is the first variant (by variant.id ASC) inside a given
  // Medusa product group. Only the driver is allowed to emit productDiffs.
  isDriver: boolean;
  // REQUIRED for non-driver calls: the product defaults that the driver will
  // establish in this run. Non-drivers compare their QB values against these
  // to decide whether an override is needed. Optional for drivers (ignored).
  proposedDefaults?: ProposedProductDefaults;
};

export type ClassifyResult = {
  classification: Classification;
  productDiffs: ProductFieldDiff[];
  variantDiffs: VariantFieldDiff[];
};

function readString(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  if (typeof v !== "string") {
    return v === null || v === undefined ? null : String(v).trim() || null;
  }
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key];
  if (v === undefined || v === null || v === "") {
    return null;
  }
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function readBool(meta: Record<string, unknown> | null, key: string): boolean | null {
  const v = meta?.[key];
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return null;
}

function eqString(a: string | null, b: string | null): boolean {
  return (a ?? "") === (b ?? "");
}

function eqNumber(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // Normalize to 4 decimals to absorb string-coerced QB values like "120.0000".
  return Math.abs(a - b) < 1e-4;
}

function pushProductDiff(
  diffs: ProductFieldDiff[],
  key: ProductMetaKey,
  oldValue: DiffValue,
  newValue: DiffValue,
): void {
  if (oldValue === newValue) return;
  if (typeof oldValue === "string" && typeof newValue === "string" && eqString(oldValue, newValue)) {
    return;
  }
  diffs.push({ key, oldValue, newValue });
}

function pushVariantDiff(
  diffs: VariantFieldDiff[],
  key: VariantMetaKey,
  oldValue: DiffValue,
  newValue: DiffValue,
  clearing: boolean,
): void {
  diffs.push({ key, oldValue, newValue, clearing });
}

/**
 * Helper to compute proposed product defaults from the DRIVER's QB snapshot.
 * Orchestrator pattern:
 *   1. Pick driver per product (first variant.id ASC).
 *   2. Call computeProposedDefaults(driverQb, product) → pass to siblings.
 *   3. Classify driver first (isDriver=true), then siblings (isDriver=false, pass proposed).
 */
export function computeProposedDefaults(
  driverQb: QbItemSnapshot,
  product: MedusaProductView,
): ProposedProductDefaults {
  const cur = product.metadata;
  return {
    income: driverQb.incomeAccountFullName !== undefined
      ? driverQb.incomeAccountFullName
      : readString(cur, "qb_income_account_full_name"),
    cogs: driverQb.cogsAccountFullName !== undefined
      ? driverQb.cogsAccountFullName
      : readString(cur, "qb_cogs_account_full_name"),
    vendorName: driverQb.vendorFullName !== undefined
      ? driverQb.vendorFullName
      : readVendorFullName(cur),
    vendorListId: driverQb.vendorListId !== undefined
      ? driverQb.vendorListId
      : readVendorListId(cur),
    itemType: driverQb.itemType,
  };
}

export function classifyMetadataDiff(input: ClassifyInput): ClassifyResult {
  const { qb, variant, product, isDriver } = input;
  const productDiffs: ProductFieldDiff[] = [];
  const variantDiffs: VariantFieldDiff[] = [];

  // Field absence semantics: undefined = "QB did not report this field" → skip.
  // Only fields QB explicitly reported (null or value) participate in diffs.

  // ── PRODUCT-LEVEL (driver only) ─────────────────────────────────────────
  const currentIncome = readString(product.metadata, "qb_income_account_full_name");
  const currentCogs = readString(product.metadata, "qb_cogs_account_full_name");
  const currentVendorName = readVendorFullName(product.metadata);
  const currentVendorId = readVendorListId(product.metadata);
  const currentItemType = readString(product.metadata, "qb_item_type");

  // Proposed defaults:
  //   - Driver: QB value when reported; else current (no signal = no touch).
  //   - Non-driver: driver's proposed defaults (passed in); fallback to current.
  const proposedIncome = isDriver
    ? qb.incomeAccountFullName !== undefined
      ? qb.incomeAccountFullName
      : currentIncome
    : input.proposedDefaults?.income ?? currentIncome;
  const proposedCogs = isDriver
    ? qb.cogsAccountFullName !== undefined
      ? qb.cogsAccountFullName
      : currentCogs
    : input.proposedDefaults?.cogs ?? currentCogs;
  const proposedVendorName = isDriver
    ? qb.vendorFullName !== undefined
      ? qb.vendorFullName
      : currentVendorName
    : input.proposedDefaults?.vendorName ?? currentVendorName;
  const proposedVendorId = isDriver
    ? qb.vendorListId !== undefined
      ? qb.vendorListId
      : currentVendorId
    : input.proposedDefaults?.vendorListId ?? currentVendorId;
  const proposedItemType = isDriver
    ? qb.itemType
    : input.proposedDefaults?.itemType ?? currentItemType;

  if (isDriver) {
    if (qb.incomeAccountFullName !== undefined) {
      pushProductDiff(productDiffs, "qb_income_account_full_name", currentIncome, proposedIncome);
    }
    if (qb.cogsAccountFullName !== undefined) {
      pushProductDiff(productDiffs, "qb_cogs_account_full_name", currentCogs, proposedCogs);
    }
    // Both names are diffed from the SAME current/proposed pair, so the sync
    // keeps the renamed key and its legacy alias in lockstep. `currentVendor*`
    // already resolves new-then-legacy, which means a product that only has the
    // legacy key gets the new one proposed and written on the next sync.
    if (qb.vendorFullName !== undefined) {
      pushProductDiff(productDiffs, "vendor_full_name", readString(product.metadata, "vendor_full_name"), proposedVendorName);
      pushProductDiff(productDiffs, "qb_vendor_full_name", readString(product.metadata, "qb_vendor_full_name"), proposedVendorName);
    }
    if (qb.vendorListId !== undefined) {
      pushProductDiff(productDiffs, "vendor_list_id", readString(product.metadata, "vendor_list_id"), proposedVendorId);
      pushProductDiff(productDiffs, "qb_vendor_list_id", readString(product.metadata, "qb_vendor_list_id"), proposedVendorId);
    }
    pushProductDiff(productDiffs, "qb_item_type", currentItemType, proposedItemType);
  }

  // ── VARIANT-LEVEL (always) ──────────────────────────────────────────────

  // ListID repair — always non-null for a matched QB item.
  const currentListId = readString(variant.metadata, "quickbooks_id");
  if (!eqString(currentListId, qb.listId)) {
    pushVariantDiff(variantDiffs, "quickbooks_id", currentListId, qb.listId, false);
  }

  // SKU mirror on variant.metadata (variant.sku field itself is out of scope).
  const currentQbSku = readString(variant.metadata, "qb_sku");
  if (qb.sku && !eqString(currentQbSku, qb.sku)) {
    pushVariantDiff(variantDiffs, "qb_sku", currentQbSku, qb.sku, false);
  }

  if (qb.editSequence !== undefined) {
    const currentEditSeq = readString(variant.metadata, "qb_edit_sequence");
    if (!eqString(currentEditSeq, qb.editSequence)) {
      pushVariantDiff(variantDiffs, "qb_edit_sequence", currentEditSeq, qb.editSequence, false);
    }
  }

  if (qb.isActive !== undefined) {
    const currentIsActive = readBool(variant.metadata, "qb_is_active");
    if (currentIsActive !== qb.isActive) {
      pushVariantDiff(variantDiffs, "qb_is_active", currentIsActive, qb.isActive, false);
    }
  }

  // Direct string variant fields.
  const directStringFields: Array<[VariantMetaKey, string | null | undefined]> = [
    ["mpn", qb.mpn],
    ["sales_description", qb.salesDesc],
    ["qb_purchase_desc", qb.purchaseDesc],
  ];
  for (const [key, qbValue] of directStringFields) {
    if (qbValue === undefined) continue;
    const currentValue = readString(variant.metadata, key);
    if (!eqString(currentValue, qbValue)) {
      pushVariantDiff(variantDiffs, key, currentValue, qbValue, false);
    }
  }

  // Numeric variant fields.
  const directNumberFields: Array<[VariantMetaKey, number | null | undefined]> = [
    ["purchase_cost", qb.purchaseCost],
    ["qb_avg_cost", qb.avgCost],
  ];
  for (const [key, qbValue] of directNumberFields) {
    if (qbValue === undefined) continue;
    const currentValue = readNumber(variant.metadata, key);
    if (!eqNumber(currentValue, qbValue)) {
      pushVariantDiff(variantDiffs, key, currentValue, qbValue, false);
    }
  }

  // ── OVERRIDES ───────────────────────────────────────────────────────────
  // Skip entirely if QB did not report the underlying field.
  const overrides: Array<[VariantMetaKey, string | null | undefined, string | null]> = [
    ["qb_override_income_account", qb.incomeAccountFullName, proposedIncome],
    ["qb_override_cogs_account", qb.cogsAccountFullName, proposedCogs],
    ["qb_override_vendor_full_name", qb.vendorFullName, proposedVendorName],
    ["qb_override_vendor_qb_id", qb.vendorListId, proposedVendorId],
  ];
  for (const [key, qbValue, productDefault] of overrides) {
    if (qbValue === undefined) continue;
    const currentOverride = readString(variant.metadata, key);
    const shouldHaveOverride = qbValue !== null && !eqString(qbValue, productDefault);
    const desiredOverride = shouldHaveOverride ? qbValue : null;
    if (!eqString(currentOverride, desiredOverride)) {
      pushVariantDiff(
        variantDiffs,
        key,
        currentOverride,
        desiredOverride,
        desiredOverride === null && currentOverride !== null,
      );
    }
  }

  // ── CLASSIFICATION ──────────────────────────────────────────────────────
  const hasProduct = productDiffs.length > 0;
  const hasVariant = variantDiffs.length > 0;
  const allClearing = hasVariant && variantDiffs.every((d) => d.clearing);

  let classification: Classification;
  if (!hasProduct && !hasVariant) {
    classification = "NO_CHANGE";
  } else if (hasProduct && hasVariant) {
    classification = "BOTH_UPDATE";
  } else if (hasProduct) {
    classification = "PRODUCT_UPDATE";
  } else if (allClearing) {
    classification = "OVERRIDE_CLEARED";
  } else {
    classification = "VARIANT_UPDATE";
  }

  return { classification, productDiffs, variantDiffs };
}
