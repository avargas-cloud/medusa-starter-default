/**
 * Pure planner for the storefront "Related Products" section.
 *
 * Input is whatever the caller already resolved (curated ids, candidate
 * status/stock, same-category fallback ids); output is an ordered id list.
 * No I/O here so the ordering rules can be unit-tested exhaustively —
 * see __tests__/lib/related-products/plan-related.unit.spec.ts.
 *
 * Rules, in priority order:
 *   1. Curated order is the operator's and is preserved.
 *   2. Non-published or unknown ids are dropped.
 *   3. Out-of-stock curated items sink to the end (stable).
 *   4. Fallback fills up to `limit`, never repeating an id nor `selfId`.
 */

export interface RelatedCandidate {
  id: string;
  published: boolean;
  inStock: boolean;
}

export interface PlanRelatedInput {
  selfId: string;
  curatedIds: readonly string[];
  candidates: readonly RelatedCandidate[];
  fallbackIds: readonly string[];
  limit: number;
}

export const planRelatedProducts = (input: PlanRelatedInput): string[] => {
  const { selfId, curatedIds, candidates, fallbackIds, limit } = input;
  const byId = new Map(candidates.map((c) => [c.id, c] as const));

  const seen = new Set<string>([selfId]);
  const inStock: string[] = [];
  const outOfStock: string[] = [];

  for (const id of curatedIds) {
    if (seen.has(id)) continue;
    const c = byId.get(id);
    if (!c || !c.published) continue;
    seen.add(id);
    (c.inStock ? inStock : outOfStock).push(id);
  }

  const ordered = [...inStock, ...outOfStock];
  for (const id of fallbackIds) {
    if (ordered.length >= limit) break;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  return ordered.slice(0, Math.max(0, limit));
};
