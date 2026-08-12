/**
 * Loads the LIVE (right-now) cost/retail/wholesale for a set of variants —
 * shared by submit (to snapshot `old_*`) and detail (to compute `drifted`).
 *
 * Reads the SAME sources `writeVariantPrices`/the bulk route read: the
 * base-currency `price` row (no `price_list_id` = retail) and the
 * `WHOLESALE_PRICE_LIST_ID` row for wholesale, plus `metadata.purchase_cost`
 * for cost. Read-only — never writes.
 */
import { WHOLESALE_PRICE_LIST_ID } from "../../../../../lib/pos/price-write";
import type { PinConn } from "../../../../../lib/pos/verify-supervisor-pin";

export interface LiveVariantSnapshot {
  variant_id: string;
  product_id: string;
  sku: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  price_set_id: string | undefined;
  current_cost: number | null;
  current_retail: number | null;
  current_wholesale: number | null;
}

type VariantRow = {
  id: string;
  sku: string | null;
  product_id: string;
  metadata: Record<string, unknown> | null;
  price_set: { id: string } | { id: string }[] | null;
  product?: { title?: string | null } | null;
};

const priceSetIdOf = (v: VariantRow): string | undefined => {
  const raw = v.price_set;
  return Array.isArray(raw) ? raw[0]?.id : raw?.id;
};

const numOrNull = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export async function loadLiveVariantSnapshots(
  query: { graph: (args: unknown) => Promise<{ data: unknown[] }> },
  knex: PinConn,
  variantIds: string[]
): Promise<Map<string, LiveVariantSnapshot>> {
  const out = new Map<string, LiveVariantSnapshot>();
  if (variantIds.length === 0) return out;

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: [
      "id",
      "sku",
      "product_id",
      "metadata",
      "price_set.id",
      "product.title",
    ],
    filters: { id: variantIds },
  });

  const rows = variants as VariantRow[];
  const priceSetIds = rows
    .map((v) => priceSetIdOf(v))
    .filter((id): id is string => Boolean(id));

  const priceByPriceSet = new Map<
    string,
    { retail: number | null; wholesale: number | null }
  >();
  if (priceSetIds.length > 0) {
    const { rows: priceRows } = await knex.raw(
      `SELECT price_set_id, price_list_id, amount
         FROM price
        WHERE price_set_id = ANY(?) AND currency_code = 'usd' AND deleted_at IS NULL`,
      [priceSetIds]
    );
    for (const r of priceRows as {
      price_set_id: string;
      price_list_id: string | null;
      amount: number;
    }[]) {
      const entry = priceByPriceSet.get(r.price_set_id) ?? {
        retail: null,
        wholesale: null,
      };
      if (!r.price_list_id) entry.retail = Number(r.amount);
      else if (r.price_list_id === WHOLESALE_PRICE_LIST_ID)
        entry.wholesale = Number(r.amount);
      priceByPriceSet.set(r.price_set_id, entry);
    }
  }

  for (const v of rows) {
    const priceSetId = priceSetIdOf(v);
    const prices = priceSetId
      ? (priceByPriceSet.get(priceSetId) ?? { retail: null, wholesale: null })
      : { retail: null, wholesale: null };
    out.set(v.id, {
      variant_id: v.id,
      product_id: v.product_id,
      sku: v.sku,
      description: v.product?.title ?? v.sku ?? null,
      metadata: v.metadata,
      price_set_id: priceSetId,
      current_cost: numOrNull((v.metadata ?? {}).purchase_cost),
      current_retail: prices.retail,
      current_wholesale: prices.wholesale,
    });
  }

  return out;
}
