/**
 * src/modules/price-change/service.ts
 * MedusaService auto-generates CRUD methods: createPriceChangeBatches,
 * updatePriceChangeBatches, listPriceChangeLines, etc.
 */

import { MedusaService } from "@medusajs/utils";
import type { Context } from "@medusajs/types";

import PriceChangeBatch from "./models/price-change-batch";
import PriceChangeLine from "./models/price-change-line";

class PriceChangeModuleService extends MedusaService({
  PriceChangeBatch,
  PriceChangeLine,
}) {
  /**
   * Run `work` inside a single physical DB transaction on the price-change
   * module's connection — same pattern as `InvoiceModuleService.withTransaction`
   * (src/modules/invoices/service.ts). Used by the submit route so the
   * `price_change_batch` display-number counter claim, the batch insert, and
   * the line inserts commit atomically: a rollback never burns a number.
   */
  async withTransaction<T>(
    work: (sharedContext: Context) => Promise<T>
  ): Promise<T> {
    // `baseRepository_` is injected by MedusaService at runtime but is
    // protected and absent from the generated public type — reach it through
    // a minimal cast.
    const repo = (
      this as unknown as {
        baseRepository_: {
          transaction<R>(task: (tm: unknown) => Promise<R>): Promise<R>;
        };
      }
    ).baseRepository_;
    return repo.transaction<T>(async (transactionManager) =>
      work({ transactionManager })
    );
  }
}

export default PriceChangeModuleService;
