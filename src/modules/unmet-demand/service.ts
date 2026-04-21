/**
 * src/modules/unmet-demand/service.ts
 *
 * Wraps the two unmet-demand models. Numbering is delegated to the shared
 * Postgres sequence `custom_unmet_demand_seq` — see migration 20260420200000.
 */

import { MedusaService } from "@medusajs/utils";

import { UnmetDemandRecord } from "./models/unmet-demand-record";
import { UnmetDemandItem } from "./models/unmet-demand-item";

class UnmetDemandModuleService extends MedusaService({
  UnmetDemandRecord,
  UnmetDemandItem,
}) {
  /**
   * Allocate the next sequence number from `custom_unmet_demand_seq`.
   * Caller composes the final number as `UMD-${seq}`.
   */
  async getNextSequence(): Promise<number> {
    const rows = (await this.getManager().execute(
      `SELECT nextval('custom_unmet_demand_seq') AS seq;`
    )) as Array<{ seq: number | string }>;

    const row = rows[0];
    if (!row) {
      throw new Error(
        "custom_unmet_demand_seq nextval returned no row"
      );
    }

    return Number(row.seq);
  }

  /**
   * Physically delete items by id (no soft-delete).
   *
   * The default `deleteUnmetDemandItems()` from MedusaService sets
   * `deleted_at` and keeps the row. This method issues a real `DELETE FROM`
   * so modifying a record produces a single source of truth — no historical
   * versions hang around in the DB.
   *
   * Safe against SQL injection because Medusa IDs are ULID-like
   * (`^[A-Za-z0-9_]+$`); we still filter defensively.
   */
  async hardDeleteUnmetDemandItems(ids: string[]): Promise<void> {
    const safe = ids.filter((id) => /^[A-Za-z0-9_]+$/.test(id));
    if (safe.length === 0) return;
    const inClause = safe.map((id) => `'${id}'`).join(",");
    await this.getManager().execute(
      `DELETE FROM unmet_demand_item WHERE id IN (${inClause});`
    );
  }

  /**
   * Physically delete a single record (header). Items linked to the record
   * must be hard-deleted separately *before* this call, otherwise the FK
   * from unmet_demand_item will block the delete.
   */
  async hardDeleteUnmetDemandRecord(id: string): Promise<void> {
    if (!/^[A-Za-z0-9_]+$/.test(id)) return;
    await this.getManager().execute(
      `DELETE FROM unmet_demand_record WHERE id = '${id}';`
    );
  }

  private getManager(): { execute: (sql: string) => Promise<unknown> } {
    return (
      this as unknown as {
        __container__: {
          manager: { execute: (sql: string) => Promise<unknown> };
        };
      }
    ).__container__.manager;
  }
}

export default UnmetDemandModuleService;
