/**
 * src/modules/factory-orders/service.ts
 *
 * Wraps the 4 factory-orders models. Numbering uses three dedicated
 * Postgres sequences:
 *   custom_factory_order_seq  → FO-{seq}  (allocated at submit)
 *   custom_fo_receipt_seq     → FRCP-{seq} (allocated at receipt creation)
 *   custom_fo_draft_seq       → FOD-{seq}  (throwaway draft label)
 */

import { MedusaService } from "@medusajs/utils";

import { FactoryOrder } from "./models/factory-order";
import { FactoryOrderLine } from "./models/factory-order-line";
import { FactoryOrderReceipt } from "./models/factory-order-receipt";
import { FactoryOrderReceiptLine } from "./models/factory-order-receipt-line";

class FactoryOrdersModuleService extends MedusaService({
  FactoryOrder,
  FactoryOrderLine,
  FactoryOrderReceipt,
  FactoryOrderReceiptLine,
}) {
  async getNextFoSequence(): Promise<number> {
    return this.nextval("custom_factory_order_seq");
  }

  async getNextReceiptSequence(): Promise<number> {
    return this.nextval("custom_fo_receipt_seq");
  }

  async getNextDraftSequence(): Promise<number> {
    return this.nextval("custom_fo_draft_seq");
  }

  private async nextval(sequenceName: string): Promise<number> {
    const manager = (
      this as unknown as {
        __container__: {
          manager: { execute: (sql: string) => Promise<unknown> };
        };
      }
    ).__container__.manager;

    const rows = (await manager.execute(
      `SELECT nextval('${sequenceName}') AS seq;`
    )) as Array<{ seq: number | string }>;

    const row = rows[0];
    if (!row) throw new Error(`${sequenceName} nextval returned no row`);
    return Number(row.seq);
  }
}

export default FactoryOrdersModuleService;
