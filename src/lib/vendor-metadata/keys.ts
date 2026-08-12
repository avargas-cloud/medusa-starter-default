/**
 * The vendor of a POS product: ONE pair of PRODUCT-level metadata keys.
 *
 * `vendor_full_name` + `vendor_list_id` are what the /inventory Edit Item modal
 * shows and writes as "Preferred Vendor", what both vendor pickers filter by,
 * and what the Meili `inventory.vendorName` is built from. They are always read
 * together — a reader that resolves one and hand-rolls the other is how the two
 * halves drift apart — so they live here as a pair and nowhere else.
 *
 * NOT the vendor: the `qb_vendor` ↔ `product_variant` remote link table. That is
 * an older, variant-level association that diverges from this metadata on 105
 * production variants (measured 2026-08-12) and is only a last-resort fallback
 * inside `build-inventory-docs.ts`.
 *
 * ## The old names are gone
 *
 * These keys were `qb_vendor_full_name` / `qb_vendor_list_id` until 2026-08-12.
 * The rename shipped in two halves: an expand that wrote both spellings, and a
 * contract that removed the old ones from the code and then from the database.
 * There is no fallback left on purpose — a reader that still consulted the old
 * name would silently keep a dead key alive and hide the fact that some writer
 * never got migrated.
 */

export const VENDOR_FULL_NAME_KEY = "vendor_full_name" as const;
export const VENDOR_LIST_ID_KEY = "vendor_list_id" as const;

type AnyMeta = Record<string, unknown> | null | undefined;

function readKey(meta: AnyMeta, key: string): string | null {
  const raw = meta?.[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** Vendor display name from product metadata. */
export function readVendorFullName(meta: AnyMeta): string | null {
  return readKey(meta, VENDOR_FULL_NAME_KEY);
}

/** QuickBooks ListID of the vendor, from product metadata. */
export function readVendorListId(meta: AnyMeta): string | null {
  return readKey(meta, VENDOR_LIST_ID_KEY);
}

/**
 * The metadata patch for a vendor write.
 *
 * `undefined` is preserved verbatim so callers that run the result through a
 * `pruneUndefined` (the POS edit workflows, which only persist the fields the
 * edit actually provided) keep that behaviour on both keys. `null` is a real
 * value and CLEARS the field — Medusa's `update*` deep-merges JSONB, so
 * omitting a key keeps the old value rather than removing it.
 */
export function vendorMetadataPatch(
  fullName: string | null | undefined,
  listId: string | null | undefined
): Record<string, string | null | undefined> {
  return {
    [VENDOR_FULL_NAME_KEY]: fullName,
    [VENDOR_LIST_ID_KEY]: listId,
  };
}

/**
 * SQL expression for the vendor name of a product, for the given table alias.
 *
 * Emits a literal key name and NO bind placeholder on purpose: knex.raw treats
 * every `?` as a binding, so returning a parameterised fragment here would
 * change the binding count of every caller's query.
 *
 * @example `SELECT ${vendorFullNameSql("p")} AS vendor FROM product p`
 */
export function vendorFullNameSql(alias: string): string {
  return `NULLIF(TRIM(${alias}.metadata->>'${VENDOR_FULL_NAME_KEY}'), '')`;
}

/** SQL expression for the vendor QuickBooks ListID. See `vendorFullNameSql`. */
export function vendorListIdSql(alias: string): string {
  return `NULLIF(TRIM(${alias}.metadata->>'${VENDOR_LIST_ID_KEY}'), '')`;
}
