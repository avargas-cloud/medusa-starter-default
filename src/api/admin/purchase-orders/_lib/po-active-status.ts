/**
 * src/api/admin/purchase-orders/_lib/po-active-status.ts
 *
 * What counts as "still coming" — the definition of on-order.
 *
 * These two lists used to live inline inside `on-order/route.ts`. The moment a
 * second reader needed them (`inbound-by-sku`, which decomposes the very number
 * `/on-order` returns) copying them became a trap: the two endpoints would agree
 * until someone edited one list, and then a modal would show a total that
 * disagreed with the rows underneath it — the exact failure the modal exists to
 * prevent.
 *
 * One definition, both readers. `verify-inbound-by-sku.ts` asserts they still
 * produce the same number.
 */

/** PO lifecycle states that can still deliver goods. */
export const ACTIVE_PO_STATUSES = ["submitted", "partially_received"] as const;

/** Line states with units still outstanding. */
export const ACTIVE_PO_LINE_STATUSES = ["open", "partial"] as const;
