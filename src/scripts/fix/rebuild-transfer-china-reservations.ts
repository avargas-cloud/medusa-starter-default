/**
 * Rebuild China reservations for existing Transfer-to-USA documents.
 *
 * Dry-run:
 *   yarn medusa exec ./src/scripts/fix/rebuild-transfer-china-reservations.ts
 *
 * Apply:
 *   yarn medusa exec ./src/scripts/fix/rebuild-transfer-china-reservations.ts apply
 */

import type { ExecArgs } from "@medusajs/framework/types";

import { rebuildTransferChinaReservations } from "../../lib/inventory-transfer-reservations";
import { syncInventoryItemToMeiliSearchWorkflow } from "../../workflows/sync-inventory-item-meilisearch";

type KnexRaw = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface TransferRow {
  id: string;
  number: string | null;
  status: string;
  linked_purchase_order_id: string | null;
  pending_units: number;
}

export default async function rebuildTransferChinaReservationsScript({
  container,
  args,
}: ExecArgs): Promise<void> {
  const apply = args.includes("apply") || process.env.APPLY === "1";
  const knex = container.resolve("__pg_connection__") as KnexRaw;

  const result = await knex.raw(
    `SELECT
        it.id,
        it.number,
        it.status,
        it.linked_purchase_order_id,
        COALESCE(SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0))), 0)::int AS pending_units
      FROM inventory_transfer it
      JOIN inventory_transfer_line itl
        ON itl.transfer_id = it.id
       AND itl.deleted_at IS NULL
      WHERE it.deleted_at IS NULL
        AND it.status IN ('confirmed', 'shipped')
        AND it.linked_purchase_order_id IS NOT NULL
      GROUP BY it.id, it.number, it.status, it.linked_purchase_order_id
      HAVING COALESCE(SUM(GREATEST(0, itl.qty - COALESCE(itl.qty_received, 0))), 0) > 0
      ORDER BY it.status, it.number`
  );
  const transfers = result.rows as TransferRow[];

  console.log(
    `Transfer China reservation rebuild — mode=${apply ? "APPLY" : "DRY-RUN"}`
  );
  console.log(`Found ${transfers.length} active transfer(s) with pending units.`);

  for (const transfer of transfers) {
    console.log(
      `- ${transfer.number ?? transfer.id} [${transfer.status}] pending=${transfer.pending_units}`
    );

    if (!apply) continue;

    const touchedInventoryItemIds = await rebuildTransferChinaReservations(
      knex,
      transfer.id,
      transfer.linked_purchase_order_id
    );
    await Promise.allSettled(
      touchedInventoryItemIds.map((inventoryItemId) =>
        syncInventoryItemToMeiliSearchWorkflow(container).run({
          input: { inventoryItemId },
        })
      )
    );
    console.log(`  rebuilt ${touchedInventoryItemIds.length} inventory item(s)`);
  }

  if (!apply) {
    console.log(
      "Dry-run only. Re-run with positional `apply` or APPLY=1 to write reservations."
    );
  }
}
