import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * Origin-aware per-variant unit cost used to snapshot `average_unit_cost` on
 * invoice / credit-memo lines at creation time.
 *
 * TWO cost sources by product origin (business rule):
 *   • USA / local  (product.metadata.is_sourced_via_agent != 'true')
 *       → `qb_avg_cost` (dollars), refreshed by the QuickBooks avg-cost pull
 *         ("Cost Sync" page). Freshness = `qb_avg_cost_synced_at`.
 *   • China        (is_sourced_via_agent = 'true')
 *       → `avg_landed_cost_cents` / 100 (base+freight+tariff moving average),
 *         updated at vendor-bill confirm. Freshness = `avg_landed_cost_updated_at`.
 *         China products are NOT part of the QB pull, so their `qb_avg_cost`
 *         is a stale/unmaintained legacy number — NEVER use it for China.
 *
 * Fallback (both origins) when the primary is missing → the product's purchase
 * cost (`purchase_cost`, the raw acquisition cost, excludes freight/tariff);
 * `none` only when even that is absent. This keeps "every product has a cost".
 *
 * NOTE on naming: the underlying metadata keys are historically prefixed `qb_`.
 * That is the stored key name, NOT this module's concept — `source` here uses
 * clean names (average_cost / landed_cost / purchase_cost / none).
 */
export type VariantCostSource =
  | "average_cost" // USA: qb_avg_cost (QuickBooks average)
  | "landed_cost" // China: avg_landed_cost_cents (vendor-bill AVCO)
  | "purchase_cost" // fallback: purchase_cost (raw acquisition)
  | "none"; // no cost found

export type VariantAvgCost = {
  cost: number | null;
  synced_at: Date | null;
  source: VariantCostSource;
};

type CostRow = {
  id: string;
  is_china: boolean;
  average_cost: string | null;
  average_cost_updated_at: string | null;
  average_cost_source: string | null;
  qb_avg_cost: string | null;
  qb_avg_cost_synced_at: string | null;
  avg_landed_cost_cents: string | null;
  avg_landed_cost_updated_at: string | null;
  purchase_cost: string | null;
};

/**
 * Batch-fetch origin-aware unit cost for a set of variants in one raw SQL
 * round-trip. Raw pg because Medusa v2 query.graph does not reliably hydrate
 * the metadata JSONB column.
 *
 * Returns a Map keyed by variant_id. Missing variants get
 * `{ cost: null, synced_at: null, source: 'none' }`.
 */
export async function getVariantAvgCostBatch(
  container: MedusaContainer,
  variantIds: readonly string[]
): Promise<Map<string, VariantAvgCost>> {
  const result = new Map<string, VariantAvgCost>();
  const unique = Array.from(new Set(variantIds.filter((id) => !!id)));
  if (unique.length === 0) return result;

  const pgConnection = container.resolve("__pg_connection__") as {
    raw: (
      sql: string,
      bindings?: unknown[]
    ) => Promise<{ rows: CostRow[] }>;
  };

  const rows = await pgConnection.raw(
    `SELECT pv.id,
            ((p.metadata->>'is_sourced_via_agent') = 'true') AS is_china,
            pv.metadata->>'average_cost'                AS average_cost,
            pv.metadata->>'average_cost_updated_at'     AS average_cost_updated_at,
            pv.metadata->>'average_cost_source'         AS average_cost_source,
            pv.metadata->>'qb_avg_cost'                 AS qb_avg_cost,
            pv.metadata->>'qb_avg_cost_synced_at'       AS qb_avg_cost_synced_at,
            pv.metadata->>'avg_landed_cost_cents'       AS avg_landed_cost_cents,
            pv.metadata->>'avg_landed_cost_updated_at'  AS avg_landed_cost_updated_at,
            pv.metadata->>'purchase_cost'               AS purchase_cost
       FROM product_variant pv
       LEFT JOIN product p ON p.id = pv.product_id
      WHERE pv.id = ANY(?)`,
    [unique]
  );

  for (const row of rows.rows) {
    result.set(String(row.id), resolveVariantCost(row));
  }

  for (const id of unique) {
    if (!result.has(id)) {
      result.set(id, { cost: null, synced_at: null, source: "none" });
    }
  }

  return result;
}

function resolveVariantCost(row: CostRow): VariantAvgCost {
  const purchaseCost = parseNumber(row.purchase_cost);

  // Canonical field first. Treat <= 0 as non-authoritative (a vendor-bill
  // cancel/reopen can reset the running average to 0 when stock is fully
  // consumed) → fall through to the legacy origin-aware chain rather than
  // freezing a phantom $0 COGS.
  const canonical = parseNumber(row.average_cost);
  if (canonical !== null && canonical > 0) {
    return {
      cost: canonical,
      synced_at: parseDate(row.average_cost_updated_at),
      source: mapCanonicalSource(row.average_cost_source, row.is_china),
    };
  }

  if (row.is_china) {
    // China: vendor-bill landed AVCO (cents → dollars). NEVER qb_avg_cost.
    const landedCents = parseNumber(row.avg_landed_cost_cents);
    if (landedCents !== null && landedCents > 0) {
      return {
        cost: landedCents / 100,
        synced_at: parseDate(row.avg_landed_cost_updated_at),
        source: "landed_cost",
      };
    }
  } else {
    // USA / local: QuickBooks average cost.
    const avgCost = parseNumber(row.qb_avg_cost);
    if (avgCost !== null) {
      return {
        cost: avgCost,
        synced_at: parseDate(row.qb_avg_cost_synced_at),
        source: "average_cost",
      };
    }
  }

  // Fallback (both origins): raw purchase cost. No freshness signal.
  if (purchaseCost !== null) {
    return { cost: purchaseCost, synced_at: null, source: "purchase_cost" };
  }

  return { cost: null, synced_at: null, source: "none" };
}

/** Map the stored `average_cost_source` metadata string to the return enum. */
function mapCanonicalSource(
  raw: string | null,
  isChina: boolean
): VariantCostSource {
  switch (raw) {
    case "landed":
      return "landed_cost";
    case "sync":
      return "average_cost";
    case "purchase":
      return "purchase_cost";
    default:
      // Legacy rows written before source stamping: infer from origin.
      return isChina ? "landed_cost" : "average_cost";
  }
}

function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date) return raw;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}
