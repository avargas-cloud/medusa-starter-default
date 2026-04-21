/**
 * src/modules/purchase-orders/service.ts
 *
 * Wraps the 6 purchase-orders models. Numbering is delegated to two shared
 * Postgres sequences:
 *   - custom_purchase_order_seq  → allocated at submit time, format PO-{seq}
 *   - custom_po_receipt_seq      → allocated at receipt creation, format RCP-{seq}
 *
 * Sequences live in the same *_seq family as custom_estimate_seq,
 * custom_invoice_seq, custom_inventory_count_seq. They're created by the
 * initial migration and managed from the admin Accounting page.
 */

import { MedusaService } from "@medusajs/utils";

import { PurchaseOrder } from "./models/purchase-order";
import { PurchaseOrderLine } from "./models/purchase-order-line";
import { PurchaseOrderReceipt } from "./models/purchase-order-receipt";
import { PurchaseOrderReceiptLine } from "./models/purchase-order-receipt-line";
import { QbPurchaseOrderPipeline } from "./models/qb-purchase-order-pipeline";
import { QbItemReceiptPipeline } from "./models/qb-item-receipt-pipeline";

class PurchaseOrdersModuleService extends MedusaService({
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderReceipt,
  PurchaseOrderReceiptLine,
  QbPurchaseOrderPipeline,
  QbItemReceiptPipeline,
}) {
  /**
   * Allocate the next PO number from `custom_purchase_order_seq`.
   * Caller composes the final number as `PO-${seq}`.
   */
  async getNextPoSequence(): Promise<number> {
    return this.nextval("custom_purchase_order_seq");
  }

  /**
   * Allocate the next receipt number from `custom_po_receipt_seq`.
   * Caller composes the final number as `RCP-${seq}`.
   */
  async getNextReceiptSequence(): Promise<number> {
    return this.nextval("custom_po_receipt_seq");
  }

  private async nextval(sequenceName: string): Promise<number> {
    const manager = (this as unknown as {
      __container__: {
        manager: {
          execute: (sql: string) => Promise<unknown>;
        };
      };
    }).__container__.manager;

    const rows = (await manager.execute(
      `SELECT nextval('${sequenceName}') AS seq;`
    )) as Array<{ seq: number | string }>;

    const row = rows[0];
    if (!row) {
      throw new Error(`${sequenceName} nextval returned no row`);
    }

    return Number(row.seq);
  }
}

export default PurchaseOrdersModuleService;
