/**
 * src/modules/inventory-count/service.ts
 *
 * Wraps the three inventory-count models. Numbering is delegated to a shared
 * Postgres sequence (custom_inventory_count_seq) — see migrations 18190000
 * (table bootstrap) + 18200000 (sequence migration).
 */

import { MedusaService } from "@medusajs/utils";

import { InventoryCount } from "./models/inventory-count";
import { InventoryCountLine } from "./models/inventory-count-line";
import { QbInventoryAdjustmentPipeline } from "./models/qb-inventory-adjustment-pipeline";

class InventoryCountModuleService extends MedusaService({
  InventoryCount,
  InventoryCountLine,
  QbInventoryAdjustmentPipeline,
}) {
  /**
   * Allocate the next sequence number from `custom_inventory_count_seq`.
   *
   * Caller composes the final number as `INVCNT-${seq}`. Sequences are
   * shared infrastructure managed via the admin Accounting page
   * (see SequenceManagerCard).
   */
  async getNextSequence(): Promise<number> {
    const manager = (this as unknown as {
      __container__: {
        manager: {
          execute: (sql: string) => Promise<unknown>;
        };
      };
    }).__container__.manager;

    const rows = (await manager.execute(
      `SELECT nextval('custom_inventory_count_seq') AS seq;`
    )) as Array<{ seq: number | string }>;

    const row = rows[0];
    if (!row) {
      throw new Error("custom_inventory_count_seq nextval returned no row");
    }

    return Number(row.seq);
  }
}

export default InventoryCountModuleService;
