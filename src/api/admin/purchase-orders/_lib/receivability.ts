/**
 * src/api/admin/purchase-orders/_lib/receivability.ts
 *
 * Decides whether a PO line may be received via a QuickBooks ItemReceipt.
 *
 * QB Desktop only accepts Inventory Part / Inventory Assembly items on an
 * ItemReceipt. Receiving a Service / Non-Inventory / Other-Charge item (or a
 * generic "Special Item" placeholder the buyer dropped on the PO instead of
 * creating a real product) makes QB reject the whole receipt with error 3153
 * ("The specified parameters conflict with each other").
 *
 * Detection is intentionally placeholder-targeted, NOT a blanket
 * `qb_item_type != Inventory` check — the latter misfires badly on real data:
 *   - "Special Item" is mis-labeled `Inventory` in product.metadata
 *     (false negative), and
 *   - ~19 legit inventory products carry a NULL qb_item_type (false positives).
 *
 * A line is non-receivable if ANY of:
 *   1. product_variant.metadata.quickbooks_is_service === true
 *      (existing authoritative QB service/non-inventory flag), or
 *   2. product.metadata.qb_item_type ∈ {Service, NonInventory, OtherCharge}, or
 *   3. sku / title matches the "Special …" placeholder heuristic.
 *
 * NULL qb_item_type is treated as receivable (the legit-inventory default).
 */

export interface ReceivabilityProbe {
  sku: string | null | undefined;
  title?: string | null;
  /** product.metadata.qb_item_type */
  qb_item_type?: string | null;
  /** product_variant.metadata.quickbooks_is_service (coerced to boolean) */
  quickbooks_is_service?: boolean;
}

const NON_RECEIVABLE_QB_TYPES = new Set([
  "service",
  "noninventory",
  "othercharge",
]);

/** Generic placeholder items ("Special Item", "Special item 2", "Special Sale"). */
const SPECIAL_PLACEHOLDER_RE = /^special\b/i;

/**
 * Returns a human-readable reason the line cannot be received, or null if the
 * line is receivable.
 */
export function nonReceivableReason(
  probe: ReceivabilityProbe
): string | null {
  if (probe.quickbooks_is_service === true) {
    return "This is a QuickBooks service / non-inventory item and cannot be received via an Item Receipt. Create a real inventory product and replace this line.";
  }

  const qbType = (probe.qb_item_type ?? "").trim().toLowerCase();
  if (qbType && NON_RECEIVABLE_QB_TYPES.has(qbType)) {
    return `This is a QuickBooks ${probe.qb_item_type} item and cannot be received via an Item Receipt. Create a real inventory product and replace this line.`;
  }

  const sku = (probe.sku ?? "").trim();
  const title = (probe.title ?? "").trim();
  if (SPECIAL_PLACEHOLDER_RE.test(sku) || SPECIAL_PLACEHOLDER_RE.test(title)) {
    return 'This is a generic "Special Item" placeholder and cannot be received. Create the real inventory product in QuickBooks/Medusa and replace this line so it can be tracked.';
  }

  return null;
}

export interface VariantReceivabilityRow {
  variant_id: string;
  title: string | null;
  sku: string | null;
  qb_item_type: string | null;
  quickbooks_is_service: string | null; // jsonb text: 'true' | null
}

/**
 * Batch-resolves receivability for a set of product_variant ids.
 *
 * Returns a Map keyed by product_variant_id → reason (or null when
 * receivable). Variants not found in the result map are treated as receivable.
 */
export async function resolveNonReceivableReasons(
  knex: {
    raw: (sql: string, b?: unknown[]) => Promise<{ rows: unknown[] }>;
  },
  variantIds: string[]
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = Array.from(new Set(variantIds.filter(Boolean)));
  if (ids.length === 0) return out;

  const rows = (
    await knex.raw(
      `SELECT pv.id                              AS variant_id,
              pv.title                           AS title,
              pv.sku                             AS sku,
              p.metadata->>'qb_item_type'        AS qb_item_type,
              pv.metadata->>'quickbooks_is_service' AS quickbooks_is_service
         FROM product_variant pv
         JOIN product p ON p.id = pv.product_id
        WHERE pv.id = ANY(?::text[])`,
      [ids]
    )
  ).rows as VariantReceivabilityRow[];

  for (const r of rows) {
    out.set(
      r.variant_id,
      nonReceivableReason({
        sku: r.sku,
        title: r.title,
        qb_item_type: r.qb_item_type,
        quickbooks_is_service: r.quickbooks_is_service === "true",
      })
    );
  }
  return out;
}
