/**
 * qb-vendor-bill-clearing-lines.ts
 *
 * Derives the NEGATIVE clearing lines a China-agent regular bill carries in
 * QuickBooks.
 *
 * WHAT THEY ARE
 * -------------
 * On a China-agent purchase the agent's commission and the freight arrive as
 * their own vendor bills, and the regular bill's item lines already carry the
 * FULL LANDED cost — commission and freight included. Posting all three as-is
 * would bill the same money twice, so the regular bill carries one negative
 * ExpenseLine per sibling that cancels it. A/P then nets to what is actually
 * owed.
 *
 * THE RULE, verified against the real lines VB-1059 held before its rebuild
 * deleted them:
 *
 *   one negative ExpenseLine per linked sibling bill,
 *   for that sibling's CURRENT total,
 *   against that sibling's OWN qb_account_list_id.
 *
 *   VB-1060 freight  $854.00 · 8000006A-1361379664  →  -854.00, same account
 *   VB-1061 service  $346.43 · 80000185-1757423159  →  -346.43, same account
 *
 * The second row is the proof: the clearing line QuickBooks held said -328.60
 * because it was built in July, while the sibling is $346.43 today. A rebuild
 * uses the CURRENT figure — the POS is the truth — which is also why rebuilding
 * VB-1059 settles the $17.83 drift on VB-1061 in the same act.
 *
 * PURE ON PURPOSE: what QuickBooks needs is derived from data the caller has
 * already loaded, so the rule can be tested against real numbers without a
 * database or a bridge. Its output authorises money leaving A/P.
 */

export type ClearingLineKind = "freight" | "commission" | "tariff" | "other";

/** A sibling bill that the regular bill's landed cost already absorbed. */
export interface ClearingSibling {
  vendor_bill_id: string;
  number: string | null;
  bill_type: "service" | "freight" | "tariff";
  /** The sibling's own QuickBooks expense account. */
  qb_account_list_id: string | null;
  qb_account_full_name: string | null;
  /** Its current total in cents — positive. */
  total_cents: number;
}

export interface DerivedClearingLine {
  kind: ClearingLineKind;
  account_list_id: string;
  account_full_name: string | null;
  /** NEGATIVE: it cancels the sibling. */
  amount_cents: number;
  vendor_bill_id: string;
}

export type DeriveClearingLinesResult =
  | { ok: true; lines: DerivedClearingLine[] }
  | { ok: false; reason: string };

/**
 * `service` is the agent's commission — the QuickBooks account is named
 * "Commission for Purchase:…", and the clearing line it produced was tagged
 * `commission`, not `service`. Keeping the tag QuickBooks already saw matters:
 * the Mod reproduces what the Add sent.
 */
const KIND_BY_BILL_TYPE: Record<ClearingSibling["bill_type"], ClearingLineKind> =
  {
    service: "commission",
    freight: "freight",
    tariff: "tariff",
  };

/**
 * Builds the clearing lines for a regular bill from its linked siblings.
 *
 * Fails closed rather than dropping a sibling: a missing account would post a
 * bill whose A/P is overstated by that sibling's amount — money the vendor is
 * not owed — and it would look like a perfectly normal document.
 */
export function deriveClearingLines(
  siblings: ClearingSibling[]
): DeriveClearingLinesResult {
  const lines: DerivedClearingLine[] = [];

  for (const sibling of siblings) {
    // A sibling worth nothing cancels nothing. Emitting a zero line would put
    // an empty row on the QuickBooks bill for no reason.
    if (sibling.total_cents === 0) continue;

    if (sibling.total_cents < 0) {
      return {
        ok: false,
        reason: `${sibling.number ?? sibling.vendor_bill_id}: total is negative (${sibling.total_cents}c) — refusing to build a clearing line that would ADD to A/P`,
      };
    }
    if (!sibling.qb_account_list_id) {
      return {
        ok: false,
        reason: `${sibling.number ?? sibling.vendor_bill_id}: no QuickBooks account — its cost is already inside the landed item cost, so omitting it would overstate A/P by ${(sibling.total_cents / 100).toFixed(2)}`,
      };
    }

    lines.push({
      kind: KIND_BY_BILL_TYPE[sibling.bill_type],
      account_list_id: sibling.qb_account_list_id,
      account_full_name: sibling.qb_account_full_name,
      amount_cents: -sibling.total_cents,
      vendor_bill_id: sibling.vendor_bill_id,
    });
  }

  return { ok: true, lines };
}

/** A clearing line as PERSISTED on the bill — what QuickBooks is holding. */
export interface PersistedClearingLine {
  kind: ClearingLineKind;
  /** Stored NEGATIVE by both the Add and the July backfill. Read as magnitude. */
  amount_cents: number;
}

export interface ClearingDriftItem {
  kind: ClearingLineKind;
  /** The sibling's number, when the sibling still exists. */
  number: string | null;
  /** What QuickBooks currently cancels, positive. 0 = no line over there. */
  quickbooks_cents: number;
  /** What the sibling is worth today, positive. */
  current_cents: number;
}

export interface ClearingDrift {
  stale: boolean;
  /** How much A/P is off by: Σ(current − quickbooks). Signed. */
  delta_cents: number;
  items: ClearingDriftItem[];
}

/**
 * Compares what QuickBooks holds against what the siblings are worth NOW.
 *
 * Each bill syncs independently (owner decision, 2026-08-04), so editing a
 * service bill sends ITS Mod and leaves the regular's negative clearing line
 * quoting the old figure — QuickBooks' A/P is then off by the difference, on a
 * document that looks entirely normal. Nothing in the data says "stale": the
 * only way to know is to ask both sides. Measured against production on
 * 2026-08-04, one bill was already in that state — VB-1053 clears $564.51 while
 * its commission sibling VB-1054 is $566.27 today, $1.76 adrift since July.
 *
 * Derived rather than flagged on purpose: a column would have to be set by
 * every path that can move a sibling's total and cleared by every path that
 * re-sends the regular, and the first one anybody forgets makes the banner lie
 * in whichever direction is worse. This answer cannot go stale — it is
 * recomputed from the two things being compared, and it disappears on its own
 * once a Mod re-sends the current figures.
 *
 * MATCHED BY `kind`, not by id: the lines the July backfill persisted carry no
 * `vendor_bill_id`, and `kind` is also what the Mod keys on when it rebuilds
 * the amounts (`retainedClearing`). One line per kind is the shape both sides
 * already assume.
 */
export function deriveClearingDrift(
  persisted: PersistedClearingLine[],
  siblings: ClearingSibling[]
): ClearingDrift {
  const items: ClearingDriftItem[] = [];
  const seen = new Set<ClearingLineKind>();

  for (const sibling of siblings) {
    const kind = KIND_BY_BILL_TYPE[sibling.bill_type];
    seen.add(kind);
    const line = persisted.find((p) => p.kind === kind);
    const quickbooksCents = Math.abs(Number(line?.amount_cents ?? 0));
    if (quickbooksCents === sibling.total_cents) continue;
    items.push({
      kind,
      number: sibling.number,
      quickbooks_cents: quickbooksCents,
      current_cents: sibling.total_cents,
    });
  }

  // A persisted line whose sibling is gone (unlinked or deleted) still cancels
  // money in QuickBooks. Reporting it as `current 0` is the honest reading:
  // A/P over there is short by exactly that amount.
  for (const line of persisted) {
    if (line.kind === "other" || seen.has(line.kind)) continue;
    const quickbooksCents = Math.abs(Number(line.amount_cents));
    if (quickbooksCents === 0) continue;
    items.push({
      kind: line.kind,
      number: null,
      quickbooks_cents: quickbooksCents,
      current_cents: 0,
    });
  }

  return {
    stale: items.length > 0,
    delta_cents: items.reduce(
      (sum, i) => sum + (i.current_cents - i.quickbooks_cents),
      0
    ),
    items,
  };
}

/**
 * What the clearing lines remove from A/P, as a positive figure.
 *
 * Lets a caller check the arithmetic it is about to post: the QuickBooks bill's
 * total must equal the landed item total MINUS this. A payload that fails that
 * is a bill that will never reconcile against the vendor's invoice.
 */
export function clearingTotalCents(lines: DerivedClearingLine[]): number {
  return lines.reduce((sum, line) => sum + Math.abs(line.amount_cents), 0);
}
