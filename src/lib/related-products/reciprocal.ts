/**
 * Pure helpers behind PUT /admin/products/:id/related-products.
 *
 * `sanitizeRelatedIds` normalises what the widget sends; `planReciprocalWrites`
 * computes the extra lists to persist so the relation is reciprocal ON ADD
 * (operator's rule, 2026-09-10): A → [B] also appends A to B when B has room.
 * Removals never cascade — each side stays independently overridable.
 */

export const MAX_RELATED = 8;

export const sanitizeRelatedIds = (
  selfId: string,
  ids: readonly unknown[]
): string[] => {
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || id === selfId || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_RELATED) break;
  }
  return out;
};

export interface ReciprocalInput {
  selfId: string;
  previousIds: readonly string[];
  nextIds: readonly string[];
  /** Current curated list of every NEWLY added target, keyed by id. */
  targetLists: Readonly<Record<string, readonly string[]>>;
}

export interface ReciprocalPlan {
  updates: { id: string; ids: string[] }[];
  skippedFull: string[];
}

export const planReciprocalWrites = (
  input: ReciprocalInput
): ReciprocalPlan => {
  const { selfId, previousIds, nextIds, targetLists } = input;
  const before = new Set(previousIds);
  const added = nextIds.filter((id) => !before.has(id));

  const updates: ReciprocalPlan["updates"] = [];
  const skippedFull: string[] = [];

  for (const targetId of added) {
    const current = targetLists[targetId] ?? [];
    if (current.includes(selfId)) continue;
    if (current.length >= MAX_RELATED) {
      skippedFull.push(targetId);
      continue;
    }
    updates.push({ id: targetId, ids: [...current, selfId] });
  }

  return { updates, skippedFull };
};
