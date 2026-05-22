/**
 * Shared guard for building a QuickBooks Desktop PrefVendorRef.
 *
 * QB Desktop only accepts a real QB-assigned ListID (e.g. "800012DF-1554221344")
 * as a reference ListID. Passing an internal Medusa id (e.g. "qbvnd_01K…") makes
 * QB reject the whole op with "Error 3000: the given object ID … is invalid",
 * which strands the item (and any Purchase Order that references it) in the
 * pipeline. Every code path that builds a PrefVendorRef for an item add/mod MUST
 * route through `buildPrefVendorRef` so an internal id can never reach QB.
 */

/** A real QB ListID looks like "<hex>-<digits>" (e.g. "800012DF-1554221344"). */
export const isQbListId = (id: string): boolean => /^[0-9A-Fa-f]+-\d+$/.test(id);

export type QbVendorRef = { ListID: string } | { FullName: string };

/**
 * Returns a PrefVendorRef that is safe to send to QB:
 *   - a `ListID` only when the value is a real QB ListID,
 *   - otherwise a `FullName` (QB resolves the vendor by name),
 *   - otherwise `undefined` (never a poisoned internal id).
 */
export function buildPrefVendorRef(opts: {
  /** A QB ListID or an internal qb_vendor.id — only the former is emitted as ListID. */
  vendorIdOrListId?: string | null;
  vendorFullName?: string | null;
}): QbVendorRef | undefined {
  const { vendorIdOrListId, vendorFullName } = opts;

  if (vendorIdOrListId && isQbListId(vendorIdOrListId)) {
    return { ListID: vendorIdOrListId };
  }
  if (vendorFullName) {
    return { FullName: vendorFullName };
  }
  return undefined;
}
