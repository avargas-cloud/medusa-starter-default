/**
 * Shared price-row writer for POS product prices.
 *
 * Extracted from the single-variant route (`pos/prices/[productId]`) so the
 * bulk editor can reuse the EXACT same semantics: retail = the price row
 * without a `price_list_id`, wholesale = the row keyed to
 * `WHOLESALE_PRICE_LIST_ID`, both updated via `amount` AND `raw_amount`
 * together (Medusa v2 reads money from `raw_*`), insert-if-missing for either
 * row. Only the `amount` of the pre-existing rows is also read back, so a
 * caller (the bulk route) can report old → new for its audit trail.
 *
 * Both sides are OPTIONAL (single-price variants have no wholesale row — the
 * POS mirrors retail as the effective wholesale at sale time). This function
 * writes a side ONLY if the caller passes it — it never materializes a
 * wholesale row that wasn't requested. The `wholesale ≤ retail` invariant is
 * enforced here against the EFFECTIVE values (the side passed in, or the
 * pre-existing live row for the side not passed) so every caller that routes
 * through this engine (bulk editor, batch approve) gets the check for free —
 * a caller that decides BEFORE writing (batch submit) still needs its own
 * check against a live snapshot, since it never reaches this function.
 */

import { randomUUID } from "node:crypto";

export const WHOLESALE_PRICE_LIST_ID = "plist_01KFTSDZZNTQRSYNMB4YST1HYA";

// The single-variant route generated insert ids as `price_${Date.now()}_r` —
// collision-free with one variant per request, but the bulk editor inserts
// inside a 500-row loop where two missing rows in the same millisecond would
// collide the PK and abort the whole transaction.
const newPriceRowId = (suffix: "r" | "w"): string =>
  `price_${Date.now()}_${randomUUID().slice(0, 8)}_${suffix}`;

export interface PinLikeConn {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: any[] }>;
}

interface LoggerLike {
  warn: (msg: string) => void;
}

export interface WriteVariantPricesResult {
  /** Retail (base, no price_list_id) amount before this write, or null if the row didn't exist. */
  old_retail: number | null;
  /** Wholesale amount before this write, or null if the row didn't exist. */
  old_wholesale: number | null;
  /** Total active price rows for this price_set after the write (zombie-detection signal). */
  price_row_count: number;
}

/** Thrown when the effective wholesale (passed or pre-existing) would exceed
 * the effective retail (passed or pre-existing) — rejected, never clamped. */
export class PriceInvariantError extends Error {}

/** Update amount + raw_amount (Medusa v2 stores both) via Knex. */
async function updatePriceRowById(
  knex: PinLikeConn,
  id: string,
  amount: number
): Promise<void> {
  await knex.raw(
    `UPDATE price
         SET amount = ?,
             raw_amount = jsonb_build_object('value', ?::text, 'precision', 20),
             updated_at = NOW()
         WHERE id = ? AND deleted_at IS NULL`,
    [amount, String(amount), id]
  );
}

/**
 * Write the retail + wholesale price rows for one price_set, updating existing
 * rows or inserting them if missing. Same semantics as the original inline
 * logic in the single-variant route — moved here so the bulk route can call
 * the identical write path instead of re-implementing it.
 */
export async function writeVariantPrices(
  knex: PinLikeConn,
  logger: LoggerLike,
  priceSetId: string,
  retailPrice?: number,
  wholesalePrice?: number
): Promise<WriteVariantPricesResult> {
  const existing = await knex.raw(
    `SELECT id, price_list_id, amount
           FROM price
          WHERE price_set_id = ? AND currency_code = 'usd' AND deleted_at IS NULL`,
    [priceSetId]
  );
  const rows: { id: string; price_list_id: string | null; amount: number }[] =
    existing.rows;

  const retailRow = rows.find((r) => !r.price_list_id);
  const wholesaleRow = rows.find(
    (r) => r.price_list_id === WHOLESALE_PRICE_LIST_ID
  );

  const old_retail = retailRow ? Number(retailRow.amount) : null;
  const old_wholesale = wholesaleRow ? Number(wholesaleRow.amount) : null;

  // The invariant is checked against the EFFECTIVE value of each side — the
  // one passed in, or (if this write leaves that side untouched) the
  // pre-existing live row. A retail-only write with no wholesale row present
  // is always valid (the wholesale mirrors retail by design, per-caller).
  const effectiveRetail = retailPrice !== undefined ? retailPrice : old_retail;
  const effectiveWholesale =
    wholesalePrice !== undefined ? wholesalePrice : old_wholesale;
  if (
    effectiveRetail !== null &&
    effectiveWholesale !== null &&
    effectiveWholesale > effectiveRetail
  ) {
    throw new PriceInvariantError(
      `wholesale_price ($${effectiveWholesale}) cannot exceed retail_price ($${effectiveRetail}) for price_set ${priceSetId}`
    );
  }

  if (retailPrice !== undefined) {
    if (retailRow) {
      await updatePriceRowById(knex, retailRow.id, retailPrice);
    } else {
      logger.warn(
        `[pos-prices] No base USD price for price_set ${priceSetId} — inserting`
      );
      await knex.raw(
        `INSERT INTO price (id, price_set_id, currency_code, amount, raw_amount, rules_count, created_at, updated_at)
                 VALUES (?, ?, 'usd', ?, jsonb_build_object('value', ?::text, 'precision', 20), 0, NOW(), NOW())`,
        [newPriceRowId("r"), priceSetId, retailPrice, String(retailPrice)]
      );
    }
  }

  // Never materializes a wholesale row that wasn't requested — a retail-only
  // write on a single-price variant leaves it absent (the POS mirrors retail
  // as the effective wholesale at sale time).
  if (wholesalePrice !== undefined) {
    if (wholesaleRow) {
      await updatePriceRowById(knex, wholesaleRow.id, wholesalePrice);
    } else {
      logger.warn(
        `[pos-prices] No wholesale price for price_set ${priceSetId} — inserting`
      );
      await knex.raw(
        `INSERT INTO price (id, price_set_id, price_list_id, currency_code, amount, raw_amount, rules_count, created_at, updated_at)
                 VALUES (?, ?, ?, 'usd', ?, jsonb_build_object('value', ?::text, 'precision', 20), 0, NOW(), NOW())`,
        [
          newPriceRowId("w"),
          priceSetId,
          WHOLESALE_PRICE_LIST_ID,
          wholesalePrice,
          String(wholesalePrice),
        ]
      );
    }
  }

  const countResult = await knex.raw(
    `SELECT COUNT(*) as cnt FROM price WHERE price_set_id = ? AND deleted_at IS NULL`,
    [priceSetId]
  );
  const price_row_count = parseInt(countResult.rows[0].cnt, 10);

  return { old_retail, old_wholesale, price_row_count };
}
