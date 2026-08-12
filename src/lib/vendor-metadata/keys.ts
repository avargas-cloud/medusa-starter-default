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
 * ## Legacy keys and the expand/contract cutover
 *
 * These keys were named `qb_vendor_full_name` / `qb_vendor_list_id` until the
 * 2026-08-12 rename. The migration COPIES the values to the new names and
 * leaves the old ones in place, so during the Railway cutover the previous
 * build keeps reading valid data. Every reader here therefore falls back to the
 * legacy name, and every writer emits BOTH names.
 *
 * Dropping the legacy keys (and these fallbacks) is a separate, later step —
 * do not remove them while any `qb_vendor_*` key still exists in the DB.
 */

export const VENDOR_FULL_NAME_KEY = "vendor_full_name" as const;
export const VENDOR_LIST_ID_KEY = "vendor_list_id" as const;

export const LEGACY_VENDOR_FULL_NAME_KEY = "qb_vendor_full_name" as const;
export const LEGACY_VENDOR_LIST_ID_KEY = "qb_vendor_list_id" as const;

type AnyMeta = Record<string, unknown> | null | undefined;

function readKey(meta: AnyMeta, key: string): string | null {
  const raw = meta?.[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** Vendor display name from product metadata; legacy key as fallback. */
export function readVendorFullName(meta: AnyMeta): string | null {
  return (
    readKey(meta, VENDOR_FULL_NAME_KEY) ??
    readKey(meta, LEGACY_VENDOR_FULL_NAME_KEY)
  );
}

/** QuickBooks ListID of the vendor from product metadata; legacy as fallback. */
export function readVendorListId(meta: AnyMeta): string | null {
  return (
    readKey(meta, VENDOR_LIST_ID_KEY) ?? readKey(meta, LEGACY_VENDOR_LIST_ID_KEY)
  );
}

/**
 * The metadata patch for a vendor write. Emits BOTH the new and the legacy key
 * from the same value, so a build running the pre-rename code still reads the
 * right vendor and the two names can never drift apart.
 *
 * `undefined` is preserved verbatim so callers that run the result through a
 * `pruneUndefined` (the POS edit workflows, which only persist the fields the
 * edit actually provided) keep that behaviour on all four keys. `null` is a
 * real value and CLEARS the field — Medusa's `update*` deep-merges JSONB, so
 * omitting a key keeps the old value rather than removing it.
 */
export function vendorMetadataPatch(
  fullName: string | null | undefined,
  listId: string | null | undefined
): Record<string, string | null | undefined> {
  return {
    [VENDOR_FULL_NAME_KEY]: fullName,
    [VENDOR_LIST_ID_KEY]: listId,
    [LEGACY_VENDOR_FULL_NAME_KEY]: fullName,
    [LEGACY_VENDOR_LIST_ID_KEY]: listId,
  };
}

/**
 * SQL expression for the vendor name of a product, for the given table alias.
 *
 * Emits literal key names and NO bind placeholders on purpose: knex.raw treats
 * every `?` as a binding, so returning a parameterised fragment here would
 * change the binding count of every caller's query.
 *
 * @example `SELECT ${vendorFullNameSql("p")} AS vendor FROM product p`
 */
export function vendorFullNameSql(alias: string): string {
  return `COALESCE(NULLIF(TRIM(${alias}.metadata->>'${VENDOR_FULL_NAME_KEY}'), ''), NULLIF(TRIM(${alias}.metadata->>'${LEGACY_VENDOR_FULL_NAME_KEY}'), ''))`;
}

/** SQL expression for the vendor QuickBooks ListID. See `vendorFullNameSql`. */
export function vendorListIdSql(alias: string): string {
  return `COALESCE(NULLIF(TRIM(${alias}.metadata->>'${VENDOR_LIST_ID_KEY}'), ''), NULLIF(TRIM(${alias}.metadata->>'${LEGACY_VENDOR_LIST_ID_KEY}'), ''))`;
}
