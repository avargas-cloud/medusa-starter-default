type LineDiscount = {
  type?: "percent" | "fixed" | string | null;
  value?: number | string | null;
};

type InvoiceSnapshotItem = {
  id?: string;
  variant_id?: string | null;
  sku?: string | null;
  description?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  total?: number | string | null;
  // Frozen net (round-then-multiply) persisted at invoice creation. When present,
  // the sync uses it verbatim instead of recomputing the discount. NULL on legacy rows.
  net_total_cents?: number | string | null;
  discount_type?: "percent" | "fixed" | string | null;
  discount_value?: number | string | null;
};

type ParentOrderItem = {
  id?: string;
  variant_id?: string | null;
  variant?: Record<string, unknown> | null;
  title?: string | null;
  product_title?: string | null;
  unit_price?: number | string | null;
  quantity?: number | string | null;
  metadata?: {
    line_discount?: LineDiscount | null;
    original_unit_price?: number | string | null;
    sales_description?: string | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
};

export function invoiceLineDiscountCents(
  item: InvoiceSnapshotItem,
  parentItem: ParentOrderItem | null,
  grossTotalCents: number
): number {
  const discountType =
    item.discount_type ?? parentItem?.metadata?.line_discount?.type;
  const discountValue = Number(
    item.discount_value ?? parentItem?.metadata?.line_discount?.value
  );

  if (!discountType || !Number.isFinite(discountValue) || discountValue <= 0) {
    return 0;
  }

  const qty = Number(item.quantity || 0);

  if (discountType === "percent") {
    // ROUND-THEN-MULTIPLY (2026-05-29): round the discounted UNIT price to the
    // cent first, then × qty, so net/qty yields a clean rate (rate × qty ===
    // amount, calculator-clean). Mirrors the POS computeTotals exactly, so a
    // freshly-created document is correct from the root even if its stored
    // net_total_cents is somehow absent. Existing documents are protected by the
    // frozen net_total_cents backfill — this recompute never runs for them.
    if (qty <= 0) return 0;
    const unitCents = Math.round(grossTotalCents / qty);
    // (100 - value)/100, not (1 - value/100): avoids binary-float mis-rounding
    // (e.g. 115*0.9 = 103.4999… → 103 instead of 104). max(0,…) guards >100%.
    const discountedUnitCents = Math.max(
      0,
      Math.round((unitCents * (100 - discountValue)) / 100)
    );
    const netCents = discountedUnitCents * qty;
    return Math.min(grossTotalCents, Math.max(0, grossTotalCents - netCents));
  }

  if (discountType === "fixed") {
    return Math.min(grossTotalCents, Math.round(discountValue * 100) * qty);
  }

  return 0;
}

function expectedParentGrossCents(
  parentItem: ParentOrderItem,
  fallbackQty: number
): number {
  const qty = Number(parentItem.quantity ?? fallbackQty ?? 0);
  const original = Number(parentItem.metadata?.original_unit_price);
  const unit = Number(parentItem.unit_price ?? 0);
  const unitDollars =
    Number.isFinite(original) && original > 0 ? original : unit;
  return Math.round(unitDollars * qty * 100);
}

function takeBestParentItem(
  candidatesByVariant: Map<string, ParentOrderItem[]>,
  invoiceItem: InvoiceSnapshotItem
): ParentOrderItem | null {
  const variantId = invoiceItem.variant_id;
  if (!variantId) return null;
  const candidates = candidatesByVariant.get(variantId);
  if (!candidates?.length) return null;

  const qty = Number(invoiceItem.quantity || 0);
  const grossTotalCents = Number(invoiceItem.total || 0);
  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  candidates.forEach((candidate, index) => {
    const qtyPenalty = Math.abs(Number(candidate.quantity || 0) - qty) * 100000;
    const grossPenalty = Math.abs(
      expectedParentGrossCents(candidate, qty) - grossTotalCents
    );
    const score = qtyPenalty + grossPenalty;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  const [matched] = candidates.splice(bestIndex, 1);
  return matched ?? null;
}

export function buildInvoiceForceSyncActiveItems(
  invoiceItems: InvoiceSnapshotItem[],
  parentOrderItems: ParentOrderItem[]
): { activeItems: ParentOrderItem[]; invoiceLineDiscountCents: number } {
  const parentItemsByVariant = new Map<string, ParentOrderItem[]>();
  for (const item of parentOrderItems) {
    if (!item?.variant_id) continue;
    const list = parentItemsByVariant.get(item.variant_id) || [];
    list.push(item);
    parentItemsByVariant.set(item.variant_id, list);
  }

  let totalLineDiscountCents = 0;
  const activeItems = invoiceItems
    .filter((item) => Number(item.quantity ?? 0) > 0)
    .map((item) => {
      const parentItem = takeBestParentItem(parentItemsByVariant, item);
      const grossTotalCents = Number(item.total || 0);
      // Prefer the frozen net (round-then-multiply) stored at invoice creation.
      // Legacy invoices (net_total_cents NULL) fall back to the original recompute,
      // so they reproduce their original amount untouched — forward-only by design.
      const storedNet =
        item.net_total_cents != null && item.net_total_cents !== ""
          ? Number(item.net_total_cents)
          : null;
      const netTotalCents =
        storedNet != null && Number.isFinite(storedNet)
          ? Math.max(0, storedNet)
          : Math.max(
              0,
              grossTotalCents -
                invoiceLineDiscountCents(item, parentItem, grossTotalCents)
            );
      totalLineDiscountCents += grossTotalCents - netTotalCents;

      return {
        ...(parentItem || {}),
        id: parentItem?.id ?? item.id,
        variant_id: item.variant_id,
        variant: parentItem?.variant ?? {
          id: item.variant_id,
          sku: item.sku,
          metadata: {},
        },
        title:
          parentItem?.title ||
          parentItem?.product_title ||
          item.description ||
          item.sku ||
          "",
        product_title:
          parentItem?.product_title ||
          parentItem?.title ||
          item.description ||
          item.sku ||
          "",
        quantity: Number(item.quantity || 0),
        unit_price: Number(item.unit_price || 0) / 100,
        subtotal: netTotalCents / 100,
        metadata: {
          ...(parentItem?.metadata || {}),
          sales_description:
            item.description || parentItem?.metadata?.sales_description,
        },
      };
    });

  return { activeItems, invoiceLineDiscountCents: totalLineDiscountCents };
}
