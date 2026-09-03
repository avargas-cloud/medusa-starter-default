/**
 * qb-vendor-bill-sibling-dispatch.ts
 *
 * THE ONE PLACE that answers "may this secondary vendor bill be written to
 * QuickBooks yet?", for both routes that can trigger it.
 *
 * THE RULE (owner, 2026-08-31)
 * ---------------------------
 * A secondary bill (service / freight / tariff) is written to QuickBooks the
 * moment BOTH it and its regular bill are confirmed. Whichever event completes
 * the pair performs the write:
 *
 *   secondary confirmed first  → the REGULAR's confirm dispatches it
 *   regular confirmed first    → the SECONDARY's own confirm dispatches it
 *   no purchase order at all   → nothing to pair with; it dispatches itself
 *
 * WHY THIS MODULE EXISTS AT ALL
 * -----------------------------
 * The regular bill's item lines carry the FULL landed cost, so it posts one
 * NEGATIVE clearing ExpenseLine per sibling to cancel it (see
 * qb-vendor-bill-clearing-lines.ts). `loadClearingSiblings` does NOT filter by
 * status, so a regular confirmed while its freight sibling is still a draft
 * ALREADY subtracts that freight from A/P. That is correct and intended — the
 * subtraction is settled when the sibling posts its own Bill.
 *
 * It was never settled. Measured 2026-08-31 against production: of the 48 rows
 * in `qb_vendor_bill_pipeline`, all 40 with `intent='add'` are `bill_type`
 * 'regular'. Not one service/freight/tariff bill was ever enqueued for a
 * BillAdd — 18 sat `confirmed` with no pipeline row in either table, not even
 * soft-deleted, and three purchase orders (PO-1121, PO-1122, PO-1129) had their
 * regular bill living in QuickBooks with $3,605.22 of clearing lines cancelling
 * siblings that were never posted. A/P was short by exactly that.
 *
 * Nothing turned red, because a row that is never created cannot fail.
 *
 * SO: the set that gets CLEARED and the set that gets DISPATCHED must come from
 * the same place, or they can disagree — which is the whole bug. The sibling
 * SET here always comes from `loadClearingSiblings`, the same function the Add
 * uses to build the clearing lines. The extra query below only attaches state
 * to ids that function already returned; it can neither add a sibling nor drop
 * one.
 */

import { loadClearingSiblings } from "./load-clearing-siblings";
import { enqueueQbVendorBillAdd } from "./qb-vendor-bill-enqueue";

export interface SiblingDispatchKnex {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

/**
 * A regular bill whose confirm has happened is a GREEN LIGHT for its siblings.
 *
 * `cancelled` / `voided` are deliberately NOT green: that group's QuickBooks
 * document is gone or was never meant to exist, so posting a sibling against it
 * would leave a charge with no counterpart. Such a sibling stays deferred and
 * the verifier reports it, rather than this module inventing a behaviour nobody
 * specified.
 */
export const REGULAR_GREEN_LIGHT_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "synced",
]);

/**
 * Statuses in which the regular bill is a LIVE POS document — including `draft`,
 * which is what a bill under revision looks like.
 *
 * An ALLOW-list on purpose, not a deny-list of `cancelled`/`voided`: this set
 * gates a green light derived from the regular's TxnID (see
 * `parentDocumentIsLive`), so a status nobody has thought of yet must fail
 * CLOSED — defer — rather than authorise a charge into A/P.
 */
export const REGULAR_LIVE_DOCUMENT_STATUSES: ReadonlySet<string> = new Set([
  "draft",
  "confirmed",
  "synced",
]);

/** Statuses in which a SECONDARY bill is a finished document worth sending. */
export const SECONDARY_SENDABLE_STATUSES: ReadonlySet<string> = new Set([
  "confirmed",
  "synced",
]);

export interface ParentRegularFacts {
  vendor_bill_id: string;
  number: string | null;
  status: string;
  /**
   * The regular bill's own TxnID — present means its Bill EXISTS in QuickBooks
   * right now, carrying the negative clearing line that cancels this sibling,
   * whatever the POS status says. See `parentDocumentIsLive`.
   */
  already_in_quickbooks: boolean;
}

/** Everything the decision needs. No database, no I/O — see `decide*` below. */
export interface SecondaryDispatchFacts {
  bill_type: string;
  has_purchase_order: boolean;
  /** The regular bill that POINTS AT this one, or null if none does (yet). */
  parent_regular: ParentRegularFacts | null;
  /** This bill's own QuickBooks TxnID — present means it already lives there. */
  already_in_quickbooks: boolean;
}

export type SecondaryDispatchDecision =
  | { dispatch: true; reason: string }
  /**
   * `deferred: true` means "correctly waiting" — an expected, healthy state
   * that the verifier must NOT flag. `deferred: false` means "not this bill's
   * job" (a regular dispatches itself; a bill already in QuickBooks goes down
   * the Mod path). Collapsing the two is how "waiting" and "lost" became
   * indistinguishable in the first place.
   */
  | { dispatch: false; deferred: boolean; reason: string };

/**
 * PURE. Unit-testable without a database, which matters because this function
 * decides whether money reaches QuickBooks.
 */
export function decideSecondaryDispatch(
  facts: SecondaryDispatchFacts
): SecondaryDispatchDecision {
  if (facts.bill_type === "regular") {
    return {
      dispatch: false,
      deferred: false,
      reason: "a regular bill dispatches itself",
    };
  }

  if (facts.already_in_quickbooks) {
    return {
      dispatch: false,
      deferred: false,
      reason: "already in QuickBooks — a re-confirm goes down the Mod path",
    };
  }

  // No purchase order means no regular bill can ever point at this document:
  // a standalone sales commission, an operating expense. There is no pair to
  // complete, so confirming it IS the green light.
  if (!facts.has_purchase_order) {
    return {
      dispatch: true,
      reason: "standalone bill — no regular bill to wait for",
    };
  }

  if (!facts.parent_regular) {
    return {
      dispatch: false,
      deferred: true,
      reason:
        "no regular bill links this one yet — its confirm will dispatch this bill",
    };
  }

  if (REGULAR_GREEN_LIGHT_STATUSES.has(facts.parent_regular.status)) {
    return {
      dispatch: true,
      reason: `regular bill ${
        facts.parent_regular.number ?? facts.parent_regular.vendor_bill_id
      } is already confirmed`,
    };
  }

  // THE STATUS IS NOT THE DOCUMENT (2026-09-03).
  //
  // A regular bill drops back to `draft` while an operator edits it — a
  // revision — WITHOUT its QuickBooks Bill going anywhere. That Bill is still
  // there, still carrying the negative clearing line that cancels this sibling.
  // So "waiting on a draft" and "its A/P subtraction is already live and this
  // document is missing" were the same answer, and the wrong one: the sibling
  // was told to wait for an event that had already happened.
  //
  // Measured on production 2026-09-03: VB-1129 ($380.68) and VB-1130 ($585.00)
  // read as healthily WAITING on VB-1128, whose QuickBooks Bill had been
  // subtracting exactly them since 2026-08-31. A/P was short $965.68 and every
  // check was green.
  //
  // `already_in_quickbooks` is therefore a green light in its own right — but
  // only while the regular is still a LIVE document. A `cancelled`/`voided`
  // regular keeps its TxnID pointing at something that is gone, and posting a
  // charge against that leaves it with no counterpart: the case
  // REGULAR_GREEN_LIGHT_STATUSES was protecting, and still does.
  if (parentDocumentIsLive(facts.parent_regular)) {
    return {
      dispatch: true,
      reason: `regular bill ${
        facts.parent_regular.number ?? facts.parent_regular.vendor_bill_id
      } already lives in QuickBooks (status '${
        facts.parent_regular.status
      }') — its clearing line already subtracts this one`,
    };
  }

  return {
    dispatch: false,
    deferred: true,
    reason: `waiting on regular bill ${
      facts.parent_regular.number ?? facts.parent_regular.vendor_bill_id
    } (still '${facts.parent_regular.status}')`,
  };
}

/**
 * PURE. True when the regular bill's QuickBooks document exists AND the bill is
 * still a live document — the second half is what keeps a `voided` regular from
 * greenlighting a charge with nothing to cancel it.
 */
export function parentDocumentIsLive(parent: ParentRegularFacts): boolean {
  return (
    parent.already_in_quickbooks &&
    REGULAR_LIVE_DOCUMENT_STATUSES.has(parent.status)
  );
}

/**
 * Loads the facts for ONE secondary bill.
 *
 * The parent is resolved by the POINTER columns on the regular bill, not by
 * purchase order: a purchase order can carry several regular bills (partial
 * billing, 2026-07-30), and the bill that CLEARS this sibling is the one that
 * names it.
 */
export async function loadSecondaryDispatchFacts(
  knex: SiblingDispatchKnex,
  vendorBillId: string
): Promise<SecondaryDispatchFacts | null> {
  const result = await knex.raw(
    `SELECT vb.bill_type,
            (vb.purchase_order_id IS NOT NULL) AS has_po,
            (vb.qb_txn_id IS NOT NULL)         AS in_qb,
            reg.id     AS parent_id,
            reg.number AS parent_number,
            reg.status AS parent_status,
            (reg.qb_txn_id IS NOT NULL) AS parent_in_qb
       FROM vendor_bill vb
       LEFT JOIN vendor_bill reg
              ON reg.deleted_at IS NULL
             AND reg.bill_type = 'regular'
             AND vb.id IN (reg.service_vendor_bill_id,
                           reg.freight_vendor_bill_id,
                           reg.tariff_vendor_bill_id)
      WHERE vb.id = ? AND vb.deleted_at IS NULL
      ORDER BY reg.created_at DESC NULLS LAST
      LIMIT 1`,
    [vendorBillId]
  );
  const row = result.rows[0] as
    | {
        bill_type: string;
        has_po: boolean;
        in_qb: boolean;
        parent_id: string | null;
        parent_number: string | null;
        parent_status: string | null;
        parent_in_qb: boolean | null;
      }
    | undefined;
  if (!row) return null;

  return {
    bill_type: row.bill_type,
    has_purchase_order: Boolean(row.has_po),
    already_in_quickbooks: Boolean(row.in_qb),
    parent_regular:
      row.parent_id && row.parent_status
        ? {
            vendor_bill_id: row.parent_id,
            number: row.parent_number,
            status: row.parent_status,
            already_in_quickbooks: Boolean(row.parent_in_qb),
          }
        : null,
  };
}

/**
 * `skipped` = structurally not this dispatch's job (draft, already there,
 * already queued). `failed` = we decided to send it and could not.
 *
 * A DISCRIMINATOR, not a sentence. Classifying an outcome by matching its
 * message is how a guard silently stops matching after a reword — the same
 * defect this repo hit in the retry gate and in the Meili error checks.
 */
export type SiblingDispatchStatus = "queued" | "skipped" | "failed";

export interface SiblingDispatchOutcome {
  vendor_bill_id: string;
  number: string | null;
  bill_type: string;
  outcome: SiblingDispatchStatus;
  reason: string;
}

/**
 * True when this bill already has a live BillAdd in flight.
 *
 * Checked HERE rather than reading the enqueue's refusal text: a guard that
 * recognises an outcome by matching a sentence breaks the day the sentence is
 * reworded, and this repo has paid for that twice. With this check in front,
 * every `queued: false` the enqueue returns is a real failure the caller must
 * raise.
 */
async function hasLivePipelineRow(
  knex: SiblingDispatchKnex,
  vendorBillId: string
): Promise<boolean> {
  const result = await knex.raw(
    `SELECT 1
       FROM qb_vendor_bill_pipeline
      WHERE vendor_bill_id = ?
        AND deleted_at IS NULL
        AND status NOT IN ('error', 'failed_permanent')
      LIMIT 1`,
    [vendorBillId]
  );
  return result.rows.length > 0;
}

/**
 * Called by the REGULAR bill's confirm, INSIDE its transaction and BEFORE the
 * regular's own BillAdd is enqueued.
 *
 * Order matters and is not cosmetic: the dependency chain is serial per purchase
 * order, so the order things are enqueued is the order QuickBooks receives them.
 * Siblings first means A/P is never short — the clearing lines land only once
 * the bills they cancel exist.
 *
 * Siblings still in `draft` are skipped on purpose: they are not finished
 * documents. When they are confirmed they will find this regular already
 * confirmed and dispatch themselves — that is the other half of the rule.
 */
export async function dispatchConfirmedSiblings(
  knex: SiblingDispatchKnex,
  regularBillId: string
): Promise<SiblingDispatchOutcome[]> {
  const siblings = await loadClearingSiblings(knex, regularBillId);
  if (siblings.length === 0) return [];

  const ids = siblings.map((s) => s.vendor_bill_id);
  const stateResult = await knex.raw(
    `SELECT id, number, status, (qb_txn_id IS NOT NULL) AS in_qb
       FROM vendor_bill
      WHERE id = ANY(?) AND deleted_at IS NULL`,
    [ids]
  );
  const stateById = new Map(
    (
      stateResult.rows as Array<{
        id: string;
        number: string | null;
        status: string;
        in_qb: boolean;
      }>
    ).map((r) => [r.id, r])
  );

  const outcomes: SiblingDispatchOutcome[] = [];
  for (const sibling of siblings) {
    const state = stateById.get(sibling.vendor_bill_id);
    const base = {
      vendor_bill_id: sibling.vendor_bill_id,
      number: sibling.number,
      bill_type: sibling.bill_type,
    };

    // A pointer with no live row behind it is DAMAGE, not a skip: the regular
    // is about to clear a sibling that does not exist.
    if (!state) {
      outcomes.push({ ...base, outcome: "failed", reason: "sibling not found" });
      continue;
    }
    if (state.in_qb) {
      outcomes.push({
        ...base,
        outcome: "skipped",
        reason: "already in QuickBooks",
      });
      continue;
    }
    if (!SECONDARY_SENDABLE_STATUSES.has(state.status)) {
      outcomes.push({
        ...base,
        outcome: "skipped",
        reason: `not a finished document yet (status '${state.status}')`,
      });
      continue;
    }
    if (await hasLivePipelineRow(knex, sibling.vendor_bill_id)) {
      outcomes.push({
        ...base,
        outcome: "skipped",
        reason: "a BillAdd is already queued for it",
      });
      continue;
    }

    const enq = await enqueueQbVendorBillAdd(knex as never, sibling.vendor_bill_id);
    outcomes.push({
      ...base,
      outcome: enq.queued ? "queued" : "failed",
      reason: enq.queued ? "queued" : enq.reason,
    });
  }
  return outcomes;
}

/**
 * The outcomes a caller must treat as FATAL.
 *
 * A sibling that was skipped for a structural reason (draft, already in QB,
 * already queued) is fine. A sibling that we decided to send and that the
 * enqueue then refused is not: continuing would commit a regular bill whose
 * clearing lines cancel a document that will never exist. That is the state
 * this whole change removes, so it fails loudly and takes the confirm with it.
 */
export function fatalSiblingOutcomes(
  outcomes: SiblingDispatchOutcome[]
): SiblingDispatchOutcome[] {
  return outcomes.filter((o) => o.outcome === "failed");
}
