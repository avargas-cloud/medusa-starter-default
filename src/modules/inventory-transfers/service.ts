/**
 * src/modules/inventory-transfers/service.ts
 *
 * Wraps the InventoryTransfer and InventoryTransferLine models.
 * Numbering delegated to Postgres sequence:
 *   - custom_inventory_transfer_seq → allocated at creation, format IT-{seq}
 */

import { MedusaService } from "@medusajs/utils";

import { InventoryTransfer } from "./models/inventory-transfer";
import { InventoryTransferLine } from "./models/inventory-transfer-line";

class InventoryTransfersModuleService extends MedusaService({
  InventoryTransfer,
  InventoryTransferLine,
}) {
  /**
   * Allocate the next transfer number from `custom_inventory_transfer_seq`.
   * Caller composes the final number as `IT-${seq}`.
   */
  async getNextSequence(): Promise<number> {
    const manager = (
      this as unknown as {
        __container__: {
          manager: {
            execute: (sql: string) => Promise<unknown>;
          };
        };
      }
    ).__container__.manager;

    const rows = (await manager.execute(
      `SELECT nextval('custom_inventory_transfer_seq') AS seq;`
    )) as Array<{ seq: number | string }>;

    const row = rows[0];
    if (!row) {
      throw new Error("custom_inventory_transfer_seq nextval returned no row");
    }

    return Number(row.seq);
  }
}

export default InventoryTransfersModuleService;
