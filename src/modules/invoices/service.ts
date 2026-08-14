/**
 * src/modules/invoices/service.ts
 * Invoice module service — delegates CRUD to MedusaService framework methods.
 * Business logic (invoice number generation, void checks) is handled in API routes.
 */

import { MedusaService } from "@medusajs/utils";
import type { Context } from "@medusajs/types";

import { InvoicePayment } from "./models/invoice-payment";
import InvoiceTracking from "./models/invoice-tracking";
import PosInvoice from "./models/pos-invoice";
import PosInvoiceItem from "./models/pos-invoice-item";
import RoundingAdjustment from "./models/rounding-adjustment";

class InvoiceModuleService extends MedusaService({
  PosInvoice,
  PosInvoiceItem,
  InvoiceTracking,
  InvoicePayment,
  RoundingAdjustment,
}) {
  /**
   * Run `work` inside a single physical DB transaction on the invoice module's
   * connection, handing it a `sharedContext` to thread into the generated
   * create/update methods so the invoice header, items and payment commit
   * atomically with the gapless counter + dedup writes.
   *
   * Gapless numbering depends on this: the counter row is locked + advanced and
   * the pos_invoice row is inserted in the SAME transaction, so a rollback never
   * burns a number. Run counter/dedup raw SQL via the MikroORM EntityManager:
   *   (ctx.transactionManager as SqlEntityManager).execute(sql, params)
   *
   * Keep cross-module side effects (finance payment_application, QB pipeline,
   * events) OUT of this transaction — run them after it commits, idempotently.
   */
  async withTransaction<T>(
    work: (sharedContext: Context) => Promise<T>
  ): Promise<T> {
    // `baseRepository_` is injected by MedusaService at runtime but is protected
    // and absent from the generated public type — reach it through a minimal cast.
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

export default InvoiceModuleService;
