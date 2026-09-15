/**
 * vendor-bill-rebuild-shape.ts
 *
 * THE ONE PLACE that answers "does this regular bill's QuickBooks document have
 * the wrong SHAPE, so that only a rebuild (TxnDel + fresh BillAdd) can fix it?"
 *
 * Three callers share it and must not disagree: the unlock guard (may the
 * operator claim a rebuild?), the regular's reconfirm (refuse a Mod that could
 * not balance), and the bill detail (show the banner and the button).
 *
 * THE SHAPE PROBLEM (2026-09-15)
 * -----------------------------
 * A regular bill has two QuickBooks shapes (see qb-vendor-bill-enqueue.ts):
 *
 *   · CLEARING — item lines at the FULL landed cost plus one NEGATIVE
 *     ExpenseLine per linked sibling (commission / freight / tariff) that
 *     cancels it. This is what a China-agent bill sends.
 *   · LOCAL — item lines at the raw invoice cost, freight as its own positive
 *     line, no clearing.
 *
 * The Add picks the shape from `loadClearingSiblings` at the moment it runs.
 * The Mod does NOT re-pick it: it reproduces what the Add sent, refreshing the
 * clearing lines that already exist (by TxnLineID) and never creating one —
 * so a regular that reached QuickBooks in the LOCAL shape and only afterwards
 * got its siblings linked cannot be balanced by reconfirming. VB-1142
 * (V260901-I01) is that document: $2,537.60 at raw cost in QuickBooks, its
 * commission (VB-1143, $380.64) and freight (VB-1144, $762.00) posted alone
 * on 09/01 by the old dispatch rule, linked on 09/15. "Link + Reconfirm" would
 * have sent an identical Mod and left a permanent drift banner.
 *
 * Changing shape is a rebuild, and the rebuild guard only knew ONE trigger for
 * it — "a new PO-linked line the Bill has never seen" — so this case had no
 * path at all. This module names the second trigger.
 *
 * WHY THESE FOUR CONDITIONS, AND NO FEWER
 * ---------------------------------------
 *   in QuickBooks  — a bill that never got there has nothing to rebuild; its
 *                    Add will pick the right shape by itself.
 *   owned          — an adopted bill is the accountant's document; the POS
 *                    never deletes it (`adopted_bill_readonly`).
 *   linked siblings — the pointer columns on the regular, the same set
 *                    `loadClearingSiblings` clears. No siblings, no clearing
 *                    shape to want.
 *   NO persisted clearing lines — `qb_clearing_lines` is the shape's own
 *                    fingerprint (qb-vendor-bill-mod-enqueue.ts). Present means
 *                    the Bill already has the clearing shape and a Mod can
 *                    refresh it; this must NOT rebuild a bill that is fine.
 *
 * The vendor's agent flag is deliberately NOT a condition: the shape is
 * decided by the siblings (`usesClearingStructure = siblings.length > 0`), not
 * by who the vendor is — the enqueue documents why. A local vendor whose
 * regular bill somehow gained a linked freight sibling after posting has the
 * same problem and deserves the same repair.
 */

export interface RebuildShapeKnex {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

/** Everything the decision needs. No I/O — see `needsShapeRebuild`. */
export interface RebuildShapeFacts {
  bill_type: string;
  in_quickbooks: boolean;
  qb_source: string | null;
  /** Live (non-deleted) sibling bills the regular POINTS at. */
  linked_sibling_numbers: string[];
  /** Clearing lines QuickBooks is known to hold (`qb_clearing_lines`). */
  persisted_clearing_count: number;
}

export type RebuildShapeDecision =
  | { required: true; reason: string }
  | { required: false; reason: string };

/**
 * PURE. Unit-testable without a database; it authorises deleting a QuickBooks
 * document, so every branch is spelled out rather than folded into one boolean.
 */
export function needsShapeRebuild(facts: RebuildShapeFacts): RebuildShapeDecision {
  if (facts.bill_type !== "regular") {
    return { required: false, reason: "only a regular bill carries clearing lines" };
  }
  if (!facts.in_quickbooks) {
    return { required: false, reason: "not in QuickBooks yet — its Add picks the shape" };
  }
  if (facts.qb_source === "adopted") {
    return { required: false, reason: "adopted bill — the accountant's document, never rebuilt" };
  }
  if (facts.linked_sibling_numbers.length === 0) {
    return { required: false, reason: "no linked sibling bills — the local shape is correct" };
  }
  if (facts.persisted_clearing_count > 0) {
    return {
      required: false,
      reason: "the QuickBooks Bill already has the clearing shape — a Mod refreshes it",
    };
  }
  return {
    required: true,
    reason: `the QuickBooks Bill was posted without clearing lines and now links ${facts.linked_sibling_numbers.join(
      ", "
    )} — BillMod cannot add them; rebuild the Bill (TxnDel + fresh BillAdd)`,
  };
}

/**
 * Loads the facts for ONE bill. The sibling set comes from the SAME pointer
 * columns `loadClearingSiblings` reads, filtered the same way (live rows only).
 */
export async function loadRebuildShapeFacts(
  knex: RebuildShapeKnex,
  vendorBillId: string
): Promise<RebuildShapeFacts | null> {
  const result = await knex.raw(
    `SELECT vb.bill_type,
            (vb.qb_txn_id IS NOT NULL) AS in_qb,
            vb.qb_source,
            jsonb_array_length(COALESCE(vb.qb_clearing_lines, '[]'::jsonb)) AS clearing_count,
            COALESCE((
              SELECT array_agg(COALESCE(sib.number, sib.id) ORDER BY sib.number)
                FROM vendor_bill sib
               WHERE sib.deleted_at IS NULL
                 AND sib.id IN (vb.service_vendor_bill_id, vb.freight_vendor_bill_id,
                                vb.tariff_vendor_bill_id)
            ), '{}'::text[]) AS linked_siblings
       FROM vendor_bill vb
      WHERE vb.id = ? AND vb.deleted_at IS NULL`,
    [vendorBillId]
  );
  const row = result.rows[0] as
    | {
        bill_type: string;
        in_qb: boolean;
        qb_source: string | null;
        clearing_count: number | string;
        linked_siblings: string[];
      }
    | undefined;
  if (!row) return null;
  return {
    bill_type: row.bill_type,
    in_quickbooks: Boolean(row.in_qb),
    qb_source: row.qb_source,
    linked_sibling_numbers: row.linked_siblings ?? [],
    persisted_clearing_count: Number(row.clearing_count ?? 0),
  };
}
