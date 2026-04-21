/**
 * src/modules/unmet-demand/types.ts
 * Shared string-literal unions for unmet-demand records.
 *
 * Kept as unions (not TypeScript enums) to align with `model.text()`
 * columns + DB CHECK constraints — same convention as inventory-count.
 */

export const PRICE_TIERS = ["retail", "wholesale"] as const;
export type PriceTier = (typeof PRICE_TIERS)[number];

export const UNMET_DEMAND_ITEM_KINDS = ["requested", "purchased"] as const;
export type UnmetDemandItemKind = (typeof UNMET_DEMAND_ITEM_KINDS)[number];
