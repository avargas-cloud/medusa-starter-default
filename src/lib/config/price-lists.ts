/**
 * Wholesale price list id — env-overridable, falls back to the id of the
 * price list this store has always used. Centralized so no route hardcodes
 * the literal.
 */
export const WHOLESALE_PRICE_LIST_ID: string =
  process.env.WHOLESALE_PRICE_LIST_ID ?? "plist_01KFTSDZZNTQRSYNMB4YST1HYA";
