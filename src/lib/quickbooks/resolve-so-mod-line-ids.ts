import type { QbOrderItem } from "./client/types";

/**
 * Line identity for a QB SalesOrderMod: which payload line updates which
 * existing QB line.
 *
 * Extracted out of updateSalesOrderInQb so the rule below can be tested without
 * a bridge round-trip. The function is pure: it takes the live document's lines
 * and returns the TxnLineID each payload line should carry.
 */

export type ResolvedModLine = {
  item: QbOrderItem;
  txnLineId?: string;
  synthetic: boolean;
};

/**
 * "Parent:Child" → "child", lowercased. QB returns a qualified FullName for a
 * sub-item; the payload only ever carries the leaf name ("Subtotal").
 */
export function normalizeQbItemName(fullName: unknown): string {
  if (typeof fullName !== "string") return "";
  const leaf = fullName.split(":").pop() ?? fullName;
  return leaf.trim().toLowerCase();
}

export function resolveSoModLineIds(input: {
  items: readonly QbOrderItem[];
  /** SalesOrderLineRet from the live document (already an array). */
  rawLines: readonly unknown[];
  /** ListID → [TxnLineID, …] in ascending line order. */
  linesByProductId: Record<string, string[]>;
}): ResolvedModLine[] {
  // Mutable copy so .shift() never touches the cached map.
  const queue: Record<string, string[]> = Object.fromEntries(
    Object.entries(input.linesByProductId).map(([k, v]) => [k, [...v]])
  );

  // The order-level Subtotal / Discount pair travels BY NAME (no productId),
  // but QuickBooks does give those items a ListID, so they are already in the
  // queue — under a key the payload doesn't carry. Resolve it off the live
  // document so the mod UPDATES the pair instead of deleting it and appending a
  // fresh one (which is what stripped the discount from four Sales Orders
  // before 2026-08-28).
  const listIdByItemName: Record<string, string> = {};
  for (const line of input.rawLines || []) {
    const ref = (line as any)?.ItemRef;
    const name = normalizeQbItemName(ref?.FullName);
    const listId = ref?.ListID;
    if (name && listId && !listIdByItemName[name]) {
      listIdByItemName[name] = String(listId);
    }
  }

  const resolved: ResolvedModLine[] = input.items.map((item) => {
    const synthetic = Boolean(item.syntheticOrderLine);
    const key = synthetic
      ? listIdByItemName[normalizeQbItemName(item.productName)]
      : item.productId;
    return {
      item,
      txnLineId: key ? queue[key]?.shift() : undefined,
      synthetic,
    };
  });

  // A QB Subtotal totals the lines ABOVE it, and genuinely new lines are always
  // appended at the END. Reusing the pair's TxnLineIDs while a product line is
  // being added would leave that new product BELOW the Subtotal and silently
  // change what the document says — same totals, different meaning. When that
  // happens, drop the reuse: the pair goes id-less, QB recreates it last, and
  // the subtotal covers everything again. Same gate credit memos use
  // (applyQbSyntheticLineIds), for the same reason.
  const firstSynthetic = resolved.findIndex((r) => r.synthetic);
  const hasNewProductLines =
    firstSynthetic >= 0 &&
    resolved.slice(0, firstSynthetic).some((r) => !r.txnLineId);
  if (hasNewProductLines) {
    for (const r of resolved) if (r.synthetic) r.txnLineId = undefined;
  }

  return resolved;
}
