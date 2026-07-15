/**
 * src/jobs/inventory-raw-drift-guard.ts
 *
 * Safety net that guarantees MeiliSearch can never go stale because a raw-SQL
 * writer updated a numeric inventory column without its `raw_*` BigNumber mirror
 * (Medusa's ORM — and the Meili doc builder — read the raw_* column).
 *
 * Every run it scans inventory_level (all 3 quantity pairs) + reservation_item
 * for numeric ↔ raw divergence. If any is found it:
 *   1. Repairs raw_* := numeric (numeric is the truth the writer intended).
 *   2. Re-syncs the affected items to MeiliSearch.
 *   3. Logs LOUDLY (warn) with the offending item ids so the regressing writer
 *      is visible in logs — this net repairs the symptom but does NOT hide the
 *      cause. A clean run is silent.
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { syncInventoryItemToMeiliSearchWorkflow } from "../workflows/sync-inventory-item-meilisearch";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
interface KnexRaw {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount?: number }>;
}

const PAIRS = [
  { numeric: "stocked_quantity", raw: "raw_stocked_quantity" },
  { numeric: "reserved_quantity", raw: "raw_reserved_quantity" },
  { numeric: "incoming_quantity", raw: "raw_incoming_quantity" },
] as const;

export default async function inventoryRawDriftGuard(
  container: MedusaContainer
) {
  if (isScheduledJobsDisabled(container)) return;

  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const knex = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as unknown as KnexRaw;

  const affected = new Set<string>();
  const samples: string[] = [];

  for (const pair of PAIRS) {
    const rows = (
      await knex.raw(
        `SELECT inventory_item_id, location_id,
                ${pair.numeric}::text AS num, (${pair.raw}->>'value') AS raw
           FROM inventory_level
          WHERE deleted_at IS NULL
            AND ${pair.numeric} <> (${pair.raw}->>'value')::numeric`
      )
    ).rows as Array<{
      inventory_item_id: string;
      location_id: string;
      num: string;
      raw: string;
    }>;
    for (const r of rows) {
      affected.add(r.inventory_item_id);
      if (samples.length < 20)
        samples.push(
          `${pair.numeric} item=${r.inventory_item_id} loc=${r.location_id} numeric=${r.num} raw=${r.raw}`
        );
    }
    if (rows.length > 0) {
      await knex.raw(
        `UPDATE inventory_level
            SET ${pair.raw} = jsonb_build_object('value', ${pair.numeric}::text, 'precision', 20),
                updated_at = NOW()
          WHERE deleted_at IS NULL
            AND ${pair.numeric} <> (${pair.raw}->>'value')::numeric`
      );
    }
  }

  const resRows = (
    await knex.raw(
      `SELECT inventory_item_id FROM reservation_item
        WHERE deleted_at IS NULL
          AND quantity <> (raw_quantity->>'value')::numeric`
    )
  ).rows as Array<{ inventory_item_id: string }>;
  if (resRows.length > 0) {
    resRows.forEach((r) => affected.add(r.inventory_item_id));
    await knex.raw(
      `UPDATE reservation_item
          SET raw_quantity = jsonb_build_object('value', quantity::text, 'precision', 20),
              updated_at = NOW()
        WHERE deleted_at IS NULL
          AND quantity <> (raw_quantity->>'value')::numeric`
    );
  }

  if (affected.size === 0) return; // healthy — stay silent

  logger.warn(
    `[inventory-raw-drift-guard] ⚠️  Repaired BigNumber desync on ${affected.size} item(s). A raw-SQL writer updated a numeric column without its raw_* mirror. Samples:\n  ${samples.join(
      "\n  "
    )}`
  );

  let synced = 0;
  for (const inventoryItemId of affected) {
    try {
      await syncInventoryItemToMeiliSearchWorkflow(container).run({
        input: { inventoryItemId },
      });
      synced++;
    } catch (e) {
      logger.error(
        `[inventory-raw-drift-guard] meili resync failed for ${inventoryItemId}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
  logger.warn(
    `[inventory-raw-drift-guard] re-synced ${synced}/${affected.size} repaired items to MeiliSearch`
  );
}

export const config = {
  name: "inventory-raw-drift-guard",
  schedule: "*/15 * * * *",
};
