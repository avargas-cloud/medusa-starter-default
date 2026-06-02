/**
 * cancel-open-counts-for-items.ts
 *
 * Safety guard: any bulk operation that sets stocked_quantity to an absolute
 * value (not a delta) MUST call this first.  A submitted/partially-applied
 * count stores a frozen delta computed against the old stock; if the stock is
 * then overwritten the delta becomes meaningless and will silently corrupt the
 * inventory when the count is eventually approved.
 *
 * Usage (from a medusa exec script):
 *   const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
 *   const voided = await cancelOpenCountsForItems(knex, inventoryItemIds, "QB stock sync");
 *   if (voided.length) logger.warn(`Voided ${voided.length} open count(s): ${voided.map(v => v.count_number).join(", ")}`);
 */

import type { Knex } from "knex";

export interface VoidedCountInfo {
  count_id: string;
  count_number: string | null;
  lines_affected: number;
}

export async function cancelOpenCountsForItems(
  knex: Knex,
  inventoryItemIds: string[],
  reason: string
): Promise<VoidedCountInfo[]> {
  if (inventoryItemIds.length === 0) return [];

  const affected = await knex("inventory_count_line as icl")
    .join("inventory_count as ic", "ic.id", "icl.inventory_count_id")
    .whereIn("icl.inventory_item_id", inventoryItemIds)
    .whereIn("ic.status", ["submitted", "partially_applied"])
    .whereNull("ic.deleted_at")
    .whereNull("ic.voided_at")
    .select(
      knex.raw("DISTINCT ic.id as count_id"),
      "ic.number as count_number"
    );

  if (affected.length === 0) return [];

  const countIds = affected.map((r: { count_id: string }) => r.count_id);

  const lineCounts: Array<{ inventory_count_id: string; line_count: string }> =
    await knex("inventory_count_line")
      .whereIn("inventory_count_id", countIds)
      .whereNull("deleted_at")
      .groupBy("inventory_count_id")
      .select("inventory_count_id", knex.raw("COUNT(*) as line_count"));

  const lineCountMap = new Map<string, number>();
  for (const row of lineCounts) {
    lineCountMap.set(row.inventory_count_id, Number(row.line_count));
  }

  const now = new Date();
  await knex("inventory_count").whereIn("id", countIds).update({
    status: "voided",
    voided_at: now,
    void_reason: `auto-voided: ${reason}`,
    updated_at: now,
  });

  return affected.map((r: { count_id: string; count_number: string | null }) => ({
    count_id: r.count_id,
    count_number: r.count_number ?? null,
    lines_affected: lineCountMap.get(r.count_id) ?? 0,
  }));
}
