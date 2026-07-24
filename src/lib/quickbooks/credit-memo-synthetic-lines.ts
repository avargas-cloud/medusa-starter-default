/**
 * Subtotal / Discount line identity on a POS credit memo.
 *
 * A credit memo synced to QB carries two SYNTHETIC lines that have no row in
 * `pos_credit_memo_item`: the QB "Subtotal" item and the QB "Discount" item,
 * both produced by buildQbOrderDiscountLines(). Product lines keep their
 * TxnLineID in `pos_credit_memo_item.qb_txn_line_id`; the synthetic pair had
 * nowhere to live, so every CreditMemoMod sent them without a TxnLineID and QB
 * dutifully DELETED the old pair and created a new one — on CM-1087 that was
 * 1CAF78/1CAF79 → 1CB0D0/1CB0D1 in a single mod. The money was always right;
 * what churned was line identity and the QB audit trail.
 *
 * They live in `pos_credit_memo.metadata.qb_synthetic_line_ids` instead: they
 * are QB transport state (like qb_txn_id / qb_edit_sequence), not accounting
 * lines, and putting marker rows in pos_credit_memo_item would force a new
 * filter into every consumer of that table (totals, per-SKU refunded_quantity,
 * COGS categorization, print templates, the SKU→TxnLineID identity queue).
 *
 * ── The constraint that makes this delicate ──────────────────────────────────
 * A QB Subtotal item totals the lines ABOVE it. Today the pair is recreated on
 * every mod, so it always lands at the very END of the document, after every
 * product line — which is what makes the subtotal mean "all products".
 *
 * Reusing the ids turns those two into EXISTING lines, which sortLinesForMod
 * (bridge) orders by QB position, while genuinely NEW lines always go last. So
 * the moment a mod also adds a product line, reuse would place that product
 * AFTER the Subtotal and quietly change what the document says — same totals,
 * different meaning. Hence the hard gate in applyQbSyntheticLineIds(): reuse
 * ONLY when every product line in the request already exists in QB. When
 * anything is being added, we fall back to the old recreate-at-the-end
 * behaviour, which is correct by construction.
 *
 * The stored ids are written by the pipeline poller from the real CreditMemoRet
 * of the confirmed Add/Mod (see poll-submitted-rows.ts) — QB is the source of
 * truth, and a mod that dropped the pair stores nulls, so the map cannot drift.
 */

import type { QbOrderItem } from "./client/types";

/** Key under `pos_credit_memo.metadata`. */
export const CM_SYNTHETIC_LINE_IDS_META_KEY = "qb_synthetic_line_ids";

export type QbSyntheticLineIds = {
  subtotal: string | null;
  discount: string | null;
};

export const EMPTY_QB_SYNTHETIC_LINE_IDS: QbSyntheticLineIds = {
  subtotal: null,
  discount: null,
};

/** QB item FullNames buildQbOrderDiscountLines emits (see order-flow-core.ts). */
const SUBTOTAL_ITEM_NAME = "subtotal";
const DISCOUNT_ITEM_NAME = "discount";

/** "Parent:Child" → "child", lowercased. QB may return a qualified FullName. */
function normalizeItemName(fullName: unknown): string {
  if (typeof fullName !== "string") return "";
  const leaf = fullName.split(":").pop() ?? fullName;
  return leaf.trim().toLowerCase();
}

/** A stored id is only usable when it is a real QB id, never a "new" sentinel. */
function usableId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-1" || trimmed === "0") return null;
  return trimmed;
}

/**
 * Reads the persisted pair off a `pos_credit_memo.metadata` object. Never
 * throws: any shape that is not the expected one degrades to "nothing stored",
 * which simply reproduces the pre-existing recreate-every-time behaviour.
 */
export function readQbSyntheticLineIds(metadata: unknown): QbSyntheticLineIds {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.[
    CM_SYNTHETIC_LINE_IDS_META_KEY
  ];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...EMPTY_QB_SYNTHETIC_LINE_IDS };
  }
  const record = raw as Record<string, unknown>;
  return {
    subtotal: usableId(record.subtotal),
    discount: usableId(record.discount),
  };
}

/**
 * Pulls the Subtotal / Discount TxnLineIDs out of a confirmed CreditMemoRet's
 * line array. Returns nulls for a pair QB no longer has — the caller persists
 * that as-is so the stored map can never outlive the document.
 *
 * Matching is by ItemRef.FullName because those two lines are sent by name (no
 * ListID). The LAST occurrence wins: the synthetic pair is always appended at
 * the end of the document, so a product whose SKU happens to be spelled
 * "Discount" cannot steal the id.
 */
export function extractQbSyntheticLineIds(lineRet: unknown): QbSyntheticLineIds {
  const found: QbSyntheticLineIds = { ...EMPTY_QB_SYNTHETIC_LINE_IDS };
  if (!lineRet) return found;

  const lines = Array.isArray(lineRet) ? lineRet : [lineRet];
  for (const line of lines) {
    const record = line as Record<string, any> | null;
    const txnLineId = usableId(record?.TxnLineID);
    if (!txnLineId) continue;
    const name = normalizeItemName(record?.ItemRef?.FullName);
    if (name === SUBTOTAL_ITEM_NAME) found.subtotal = txnLineId;
    else if (name === DISCOUNT_ITEM_NAME) found.discount = txnLineId;
  }
  return found;
}

/**
 * Stamps the stored TxnLineIDs onto the [Subtotal, Discount] pair returned by
 * buildQbOrderDiscountLines so the Mod UPDATES them instead of recreating them.
 *
 * Returns the lines untouched (i.e. QB recreates the pair, as before) whenever
 * reuse would be unsafe or pointless:
 *   - not a Mod (an Add has no ids to reuse),
 *   - `hasNewProductLines` — a product line is being appended, and QB would then
 *     place it AFTER a reused Subtotal, changing what the subtotal totals,
 *   - either id missing — the pair is created and destroyed together; half a
 *     pair means the stored map predates the current document shape.
 */
export function applyQbSyntheticLineIds(
  discountLines: readonly QbOrderItem[],
  stored: QbSyntheticLineIds,
  opts: { isMod: boolean; hasNewProductLines: boolean }
): QbOrderItem[] {
  if (discountLines.length !== 2) return [...discountLines];
  if (!opts.isMod || opts.hasNewProductLines) return [...discountLines];
  if (!stored.subtotal || !stored.discount) return [...discountLines];

  return [
    { ...discountLines[0], TxnLineID: stored.subtotal },
    { ...discountLines[1], TxnLineID: stored.discount },
  ];
}
