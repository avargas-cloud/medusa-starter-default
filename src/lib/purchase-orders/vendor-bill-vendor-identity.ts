/**
 * vendor-bill-vendor-identity.ts
 *
 * THE INCIDENT (VB-1148, 2026-09-03, QuickBooks Error 3000)
 * -----------------------------------------------------------
 * `POST /admin/vendor-bills` snapshots `vendor.qb_list_id` onto the bill at
 * create time (`vendor_qb_list_id_snapshot`). A brand-new vendor is minted
 * with a PLACEHOLDER list id — `pending_<ts>_<rand>` — and QuickBooks does
 * not assign the real ListID until it syncs the vendor, roughly a minute
 * later. A bill created against a vendor inside that window froze the
 * placeholder into its snapshot, and the BillAdd sent it verbatim:
 * QuickBooks rejected it with `Error 3000: The given object ID "pending_..."
 * in the field "list id" is invalid`.
 *
 * WHY THIS FAILS CLOSED INSTEAD OF SENDING THE PAYLOAD ANYWAY
 * -------------------------------------------------------------
 * A BillAdd built with a dead ListID is not a harmless attempt — QuickBooks
 * refuses it the same way every time, but the row that refusal leaves behind
 * is `error` with its payload FROZEN (retries replay the stored payload,
 * never re-read the live tables). So sending it anyway does not "try and
 * fail once": it manufactures a row that fails identically forever, until a
 * human notices and manually re-enqueues. Refusing to queue at all — until
 * the identity actually resolves — is strictly better than that outcome.
 */

/**
 * A ListID is USABLE only if it exists and is not the placeholder minted
 * before QuickBooks confirms the vendor.
 */
export function isUsableQbListId(listId: string | null | undefined): boolean {
  return typeof listId === "string" && listId.length > 0 && !listId.startsWith("pending_");
}

export interface VendorIdentityFacts {
  snapshot_list_id: string | null;
  snapshot_name: string | null;
  live_list_id: string | null;
  live_name: string | null;
}

export type VendorIdentityVerdict =
  | { resolved: true; list_id: string; name: string | null; source: "snapshot" | "live" }
  | { resolved: false; reason: string };

/**
 * PURE.
 *
 * 1. The snapshot is usable → use it as-is. It exists on purpose: it freezes
 *    the vendor the document was issued to, and is never overwritten just
 *    because it happens to work.
 * 2. The snapshot is not usable but the live vendor's ListID is → fall back
 *    to it (a synced vendor after a `pending_` snapshot window).
 * 3. Neither is usable → fail closed: the vendor has not synced yet.
 * 4. No snapshot and no live vendor at all → fail closed: no identity.
 */
export function decideVendorIdentity(
  facts: VendorIdentityFacts
): VendorIdentityVerdict {
  if (isUsableQbListId(facts.snapshot_list_id)) {
    return {
      resolved: true,
      list_id: facts.snapshot_list_id as string,
      name: facts.snapshot_name,
      source: "snapshot",
    };
  }

  if (isUsableQbListId(facts.live_list_id)) {
    return {
      resolved: true,
      list_id: facts.live_list_id as string,
      name: facts.snapshot_name ?? facts.live_name,
      source: "live",
    };
  }

  if (facts.snapshot_list_id == null && facts.live_list_id == null) {
    return { resolved: false, reason: "no QuickBooks vendor identity for this bill" };
  }

  return {
    resolved: false,
    reason: "the vendor has not synced to QuickBooks yet — its list id is still pending",
  };
}

export interface VendorIdentityKnex {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * Resolves the identity and, when it had to fall back to the LIVE vendor,
 * RE-STAMPS the bill so the document stops carrying a dead id.
 */
export async function resolveVendorIdentityForBill(
  knex: VendorIdentityKnex,
  bill: {
    id: string;
    vendor_id: string | null;
    vendor_qb_list_id_snapshot: string | null;
    vendor_name_snapshot: string | null;
  }
): Promise<VendorIdentityVerdict> {
  // ONE RULE, ONE PLACE. This function used to re-implement branch 1 of
  // `decideVendorIdentity` as an early return, and a mutation test caught what
  // that costs: breaking the pure rule left the enqueue's behaviour untouched,
  // because the caller never reached it. Skipping the QUERY when the snapshot
  // already decides is an optimization; skipping the DECISION is a second copy
  // of the rule that can drift from the first.
  const snapshotUsable = isUsableQbListId(bill.vendor_qb_list_id_snapshot);

  let liveListId: string | null = null;
  let liveName: string | null = null;
  if (!snapshotUsable && bill.vendor_id) {
    const result = await knex.raw(
      `SELECT qb_list_id, full_name FROM qb_vendor WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [bill.vendor_id]
    );
    const row = (result.rows[0] ?? null) as
      | { qb_list_id: string | null; full_name: string | null }
      | null;
    liveListId = row?.qb_list_id ?? null;
    liveName = row?.full_name ?? null;
  }

  const verdict = decideVendorIdentity({
    snapshot_list_id: bill.vendor_qb_list_id_snapshot,
    snapshot_name: bill.vendor_name_snapshot,
    live_list_id: liveListId,
    live_name: liveName,
  });

  if (verdict.resolved && verdict.source === "live") {
    await knex.raw(
      `UPDATE vendor_bill
          SET vendor_qb_list_id_snapshot = ?, vendor_name_snapshot = COALESCE(vendor_name_snapshot, ?), updated_at = NOW()
        WHERE id = ? AND deleted_at IS NULL`,
      [verdict.list_id, verdict.name, bill.id]
    );
  }

  return verdict;
}
