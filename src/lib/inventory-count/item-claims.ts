/**
 * item-claims.ts
 *
 * Enforces item-level exclusivity for inventory counts:
 *
 *   At most one unresolved count line may hold the right to apply a correction
 *   for a given (inventory_item_id, stock_location_id).
 *
 * See Migration20260801000000 for the full rationale. In short: a count stores a
 * FROZEN delta applied later against LIVE stock, which survives real movements
 * but NOT a second correction of the same discrepancy — both counts measure the
 * whole gap and each applies it in full, corrupting stock and double-booking the
 * shrinkage in QuickBooks.
 *
 * The database primary key is the real guarantee. These helpers exist to give a
 * useful error (which count holds it) and to make release explicit at every
 * lifecycle transition; they are NOT the safety barrier. A racing second submit
 * that slips past the lookup still dies on the PK.
 *
 * knex note: this module uses the `__pg_connection__` knex instance, so bindings
 * are `?` — never `$1` (that is the raw pg pool's syntax and mixing them throws
 * "Expected 1 bindings, saw 0").
 */

import type { Knex } from "knex";

export const ITEM_CLAIM_TABLE = "inventory_count_item_claim";

/** Line statuses whose correction is still armed and therefore holds a claim. */
export const UNRESOLVED_LINE_STATUSES = ["pending", "blocked"] as const;

/** Header statuses whose deltas are frozen and awaiting application. */
export const ARMED_COUNT_STATUSES = ["submitted", "partially_applied"] as const;

export interface ItemClaimOwner {
  inventory_item_id: string;
  stock_location_id: string;
  inventory_count_id: string;
  /** Human-facing number (INVCNT-1085). Null only for a count that never got one. */
  inventory_count_number: string | null;
  inventory_count_status: string;
}

export interface ClaimCandidate {
  inventory_item_id: string;
  inventory_count_line_id: string;
  /** Carried through only so callers can build a readable error. */
  sku?: string | null;
}

export interface ItemClaimConflict extends ItemClaimOwner {
  sku: string | null;
  inventory_count_line_id: string;
}

interface ClaimRow {
  inventory_item_id: string;
  stock_location_id: string;
  inventory_count_id: string;
  /** Null when the header row is gone (see the LEFT JOIN note below). */
  number: string | null;
  status: string | null;
}

/**
 * Who currently holds a claim for each of these items at this location?
 *
 * Read-only. Used by the POS bulk-add lookup and by the pre-submit revalidation
 * so the cashier learns about a conflict before walking to the shelf.
 */
export async function findItemClaimOwners(
  knex: Knex,
  inventoryItemIds: string[],
  stockLocationId: string
): Promise<Map<string, ItemClaimOwner>> {
  const owners = new Map<string, ItemClaimOwner>();
  if (inventoryItemIds.length === 0) return owners;

  // LEFT JOIN on purpose: the claim table is the authority on WHO holds an
  // item, and the header only enriches the message. An inner join would drop a
  // claim whose header is missing, which would report the item as unowned while
  // the primary key keeps rejecting it — an item locked forever by a conflict
  // nobody can name. Fail closed, but stay diagnosable.
  const rows: ClaimRow[] = await knex(`${ITEM_CLAIM_TABLE} as c`)
    .leftJoin("inventory_count as ic", "ic.id", "c.inventory_count_id")
    .whereIn("c.inventory_item_id", inventoryItemIds)
    .andWhere("c.stock_location_id", stockLocationId)
    .select(
      "c.inventory_item_id",
      "c.stock_location_id",
      "c.inventory_count_id",
      "ic.number",
      "ic.status"
    );

  for (const row of rows) {
    owners.set(row.inventory_item_id, {
      inventory_item_id: row.inventory_item_id,
      stock_location_id: row.stock_location_id,
      inventory_count_id: row.inventory_count_id,
      inventory_count_number: row.number,
      inventory_count_status: row.status ?? "unknown",
    });
  }

  return owners;
}

/**
 * Internal control-flow signal: thrown inside the acquire transaction so the
 * INSERT rolls back, then caught and unwrapped into a plain return value.
 * Never escapes this module.
 */
class ItemClaimConflictError extends Error {
  constructor(public readonly conflicts: ItemClaimConflict[]) {
    super("inventory count item claim conflict");
    this.name = "ItemClaimConflictError";
  }
}

/**
 * Claim every candidate item for `inventoryCountId`, all-or-nothing.
 *
 * Returns the conflicts. An EMPTY array means every claim is now held by this
 * count; a non-empty array means NOTHING was claimed (the transaction rolled
 * back) and the caller must reject the operation.
 *
 * A row already owned by this same count is success, not a conflict — that makes
 * the call idempotent, so a retry after a partial failure downstream does not
 * deadlock the count against itself.
 */
export async function acquireItemClaims(
  knex: Knex,
  params: {
    inventoryCountId: string;
    stockLocationId: string;
    candidates: ClaimCandidate[];
  }
): Promise<ItemClaimConflict[]> {
  const { inventoryCountId, stockLocationId, candidates } = params;
  if (candidates.length === 0) return [];

  // Collapse duplicates defensively: the same item twice in one payload would
  // self-conflict on the PK and read as a foreign conflict.
  const byItem = new Map<string, ClaimCandidate>();
  for (const c of candidates) byItem.set(c.inventory_item_id, c);
  const unique = Array.from(byItem.values());

  try {
    await knex.transaction(async (trx) => {
      await trx(ITEM_CLAIM_TABLE)
        .insert(
          unique.map((c) => ({
            inventory_item_id: c.inventory_item_id,
            stock_location_id: stockLocationId,
            inventory_count_id: inventoryCountId,
            inventory_count_line_id: c.inventory_count_line_id,
          }))
        )
        // No conflict target: this must absorb BOTH the (item, location)
        // primary key and the per-line unique index.
        .onConflict()
        .ignore();

      const owners = await findItemClaimOwners(
        trx,
        unique.map((c) => c.inventory_item_id),
        stockLocationId
      );

      const conflicts: ItemClaimConflict[] = [];
      for (const candidate of unique) {
        const owner = owners.get(candidate.inventory_item_id);
        if (!owner) {
          // Neither inserted nor owned: the per-line unique index rejected it,
          // meaning this line already claims a different item. Treat as a
          // conflict rather than silently proceeding unclaimed.
          conflicts.push({
            inventory_item_id: candidate.inventory_item_id,
            stock_location_id: stockLocationId,
            inventory_count_id: inventoryCountId,
            inventory_count_number: null,
            inventory_count_status: "unknown",
            sku: candidate.sku ?? null,
            inventory_count_line_id: candidate.inventory_count_line_id,
          });
          continue;
        }
        if (owner.inventory_count_id !== inventoryCountId) {
          conflicts.push({
            ...owner,
            sku: candidate.sku ?? null,
            inventory_count_line_id: candidate.inventory_count_line_id,
          });
        }
      }

      if (conflicts.length > 0) {
        // All-or-nothing: a partially claimed count would arm some lines and
        // leave others loose, which is the exact state this table exists to
        // prevent.
        //
        // Throwing is what rolls the INSERT back. Calling trx.rollback() here
        // would reject the transaction promise instead of letting us return
        // the conflicts to the caller.
        throw new ItemClaimConflictError(conflicts);
      }
    });
    return [];
  } catch (err) {
    if (err instanceof ItemClaimConflictError) return err.conflicts;
    throw err;
  }
}

/**
 * The approve-time mutex: mark these lines as "approval in flight", atomically.
 *
 * Returns the lines this call actually locked. Fewer than requested (or zero)
 * means another approval got there first and the caller MUST abort.
 *
 * Why a stamp and not a DELETE. Taking the lock by removing the claim row looks
 * equivalent and is not: for the whole length of the approval workflow the item
 * would sit UNCLAIMED in the table, so a second request arriving in that window
 * would find it free, claim it, and apply the same delta again. The lock cannot
 * be the row whose absence means "free". Keeping the row and stamping it holds
 * the item against every other count for the entire operation.
 *
 * `approving_started_at IS NULL` in the WHERE is what serialises the two
 * requests: under READ COMMITTED the second UPDATE blocks on the first one's
 * row lock, then re-evaluates the predicate against the committed row and
 * matches nothing.
 *
 * Every exit path must call either releaseClaimsForLines (line resolved) or
 * endApproval (line still armed) — a claim left stamped is a line nobody can
 * approve until someone clears it by hand.
 */
export async function beginApproval(
  knex: Knex,
  inventoryCountId: string,
  inventoryCountLineIds: string[]
): Promise<ClaimCandidate[]> {
  if (inventoryCountLineIds.length === 0) return [];

  const rows: Array<{
    inventory_item_id: string;
    inventory_count_line_id: string;
  }> = await knex(ITEM_CLAIM_TABLE)
    .where("inventory_count_id", inventoryCountId)
    .whereIn("inventory_count_line_id", inventoryCountLineIds)
    .whereNull("approving_started_at")
    .update({ approving_started_at: knex.fn.now() })
    .returning(["inventory_item_id", "inventory_count_line_id"]);

  return rows.map((r) => ({
    inventory_item_id: r.inventory_item_id,
    inventory_count_line_id: r.inventory_count_line_id,
  }));
}

/**
 * Clear the in-flight stamp, leaving the claim held.
 *
 * For lines that survive an approval still armed (`blocked`) and for every line
 * when the approval fails and the workflow compensates back to pending.
 */
export async function endApproval(
  knex: Knex,
  inventoryCountLineIds: string[]
): Promise<number> {
  if (inventoryCountLineIds.length === 0) return 0;
  return knex(ITEM_CLAIM_TABLE)
    .whereIn("inventory_count_line_id", inventoryCountLineIds)
    .update({ approving_started_at: null });
}

/** Release every claim held by a count. Used by reject / void / cancel / delete. */
export async function releaseClaimsForCount(
  knex: Knex,
  inventoryCountId: string
): Promise<number> {
  return knex(ITEM_CLAIM_TABLE)
    .where("inventory_count_id", inventoryCountId)
    .del();
}

/** Release claims for specific lines. Used when a line reaches a resolved state. */
export async function releaseClaimsForLines(
  knex: Knex,
  inventoryCountLineIds: string[]
): Promise<number> {
  if (inventoryCountLineIds.length === 0) return 0;
  return knex(ITEM_CLAIM_TABLE)
    .whereIn("inventory_count_line_id", inventoryCountLineIds)
    .del();
}

/**
 * Human-readable reason for a 409, naming the blocking count.
 *
 * Deliberately names the count so the cashier can go find it instead of
 * retrying blindly.
 */
export function describeClaimConflicts(conflicts: ItemClaimConflict[]): string {
  const shown = conflicts
    .slice(0, 5)
    .map(
      (c) =>
        `${c.sku ?? c.inventory_item_id} (held by ${
          c.inventory_count_number ?? c.inventory_count_id
        })`
    )
    .join(", ");
  const rest =
    conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "";
  return (
    `These SKUs are already being counted in another submitted count and ` +
    `cannot be counted twice until it is approved, rejected or voided: ` +
    `${shown}${rest}.`
  );
}
