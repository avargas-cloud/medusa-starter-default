/**
 * Types and normalization for the bulk QB Desktop → Medusa metadata sync.
 *
 * QbItemRaw  = shape produced by the bridge (xml2js generic output, fields optional).
 * QbItemSnapshot = normalized, comparable shape the classifier/diff engine uses.
 */

export type QbItemType = "Inventory" | "Service" | "NonInventory";

export type QbRef = {
  ListID?: string;
  FullName?: string;
};

// Bridge response shape: xml2js with { explicitArray: false } produces single values
// for single elements and string-coerced numerics for leaf text nodes. Every field
// is optional because presence varies across Inventory / Service / NonInventory rets.
export type QbItemRaw = {
  ListID: string;
  EditSequence?: string;
  Name?: string;
  FullName?: string;
  IsActive?: string | boolean;
  ManufacturerPartNumber?: string;
  SalesDesc?: string;
  PurchaseDesc?: string;
  SalesPrice?: string | number;
  PurchaseCost?: string | number;
  AverageCost?: string | number;
  IncomeAccountRef?: QbRef;
  COGSAccountRef?: QbRef;
  PrefVendorRef?: QbRef;
  // Bridge tags the ret block it came from; orchestrator sets this from the
  // ItemInventoryRet / ItemServiceRet / ItemNonInventoryRet path.
  itemType: QbItemType;
};

/**
 * Field-presence semantics:
 *   - `undefined` = QB did NOT include this field in the response → skip, do not touch Medusa.
 *   - `null`      = QB reported the field but empty/whitespace → write null to Medusa (clear).
 *   - value       = QB reported an explicit value (including 0 or empty-string transformed) → write it.
 *
 * Required fields (listId, sku, itemType) are always present because those come
 * from the bridge envelope, not optional QB IncludeRet elements.
 */
export type QbItemSnapshot = {
  listId: string;
  editSequence: string | null | undefined;
  sku: string;
  isActive: boolean | undefined;
  mpn: string | null | undefined;
  salesDesc: string | null | undefined;
  purchaseDesc: string | null | undefined;
  purchaseCost: number | null | undefined;
  avgCost: number | null | undefined;
  incomeAccountFullName: string | null | undefined;
  cogsAccountFullName: string | null | undefined;
  vendorFullName: string | null | undefined;
  vendorListId: string | null | undefined;
  itemType: QbItemType;
};

export type MedusaVariantView = {
  id: string;
  sku: string | null;
  productId: string;
  metadata: Record<string, unknown> | null;
};

export type MedusaProductView = {
  id: string;
  metadata: Record<string, unknown> | null;
};

function parseNumberOpt(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseBoolOpt(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const t = raw.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return undefined;
}

function trimOrNullOpt(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    return raw === null ? null : null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function refFullNameOpt(ref: QbRef | undefined): string | null | undefined {
  if (ref === undefined) return undefined;
  return trimOrNullOpt(ref.FullName) ?? null;
}

function refListIdOpt(ref: QbRef | undefined): string | null | undefined {
  if (ref === undefined) return undefined;
  return trimOrNullOpt(ref.ListID) ?? null;
}

function requiredString(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/**
 * Normalize a raw QB item response into a comparable snapshot.
 * Preserves the undefined-vs-null distinction:
 *   undefined = field absent in QB response → classifier skips, never writes
 *   null      = field present in QB but empty → classifier writes null (clear)
 */
export function toSnapshot(raw: QbItemRaw): QbItemSnapshot {
  const fullName = typeof raw.FullName === "string" ? raw.FullName.trim() : "";
  const name = typeof raw.Name === "string" ? raw.Name.trim() : "";
  return {
    listId: requiredString(raw.ListID),
    editSequence: trimOrNullOpt(raw.EditSequence),
    sku: fullName || name,
    isActive: parseBoolOpt(raw.IsActive),
    mpn: trimOrNullOpt(raw.ManufacturerPartNumber),
    salesDesc: trimOrNullOpt(raw.SalesDesc),
    purchaseDesc: trimOrNullOpt(raw.PurchaseDesc),
    purchaseCost: parseNumberOpt(raw.PurchaseCost),
    avgCost: parseNumberOpt(raw.AverageCost),
    incomeAccountFullName: refFullNameOpt(raw.IncomeAccountRef),
    cogsAccountFullName: refFullNameOpt(raw.COGSAccountRef),
    vendorFullName: refFullNameOpt(raw.PrefVendorRef),
    vendorListId: refListIdOpt(raw.PrefVendorRef),
    itemType: raw.itemType,
  };
}

/**
 * Metadata key lists — single source of truth. Anything not in these lists is
 * considered foreign to this sync and MUST be preserved untouched in payloads.
 */
export const PRODUCT_METADATA_KEYS = [
  "qb_income_account_full_name",
  "qb_cogs_account_full_name",
  "vendor_full_name",
  "vendor_list_id",
  "qb_item_type",
] as const;

export const VARIANT_METADATA_KEYS = [
  "quickbooks_id",
  "qb_sku",
  "qb_edit_sequence",
  "qb_is_active",
  "mpn",
  "sales_description",
  "qb_purchase_desc",
  "purchase_cost",
  "qb_avg_cost",
  "qb_override_income_account",
  "qb_override_cogs_account",
  "qb_override_vendor_full_name",
  "qb_override_vendor_qb_id",
] as const;

export type ProductMetaKey = (typeof PRODUCT_METADATA_KEYS)[number];
export type VariantMetaKey = (typeof VARIANT_METADATA_KEYS)[number];
