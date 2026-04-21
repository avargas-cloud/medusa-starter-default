/**
 * src/modules/purchase-orders/index.ts
 * Module definition — register in medusa-config.ts as resolve: './src/modules/purchase-orders'
 *
 * Stores purchase order drafts and submitted snapshots, physical receipt
 * records (one PO can be received in multiple shipments), and the QuickBooks
 * PurchaseOrder + ItemReceipt sync pipelines.
 *
 * Design rules:
 *   - Numbering allocated via shared Postgres sequences at submit/receive time
 *     (custom_purchase_order_seq, custom_po_receipt_seq).
 *   - Vendor metadata snapshotted on the PO at submit time so future vendor
 *     edits never mutate existing POs.
 *   - Cost snapshots on every line and receipt line — vendor pricing is
 *     negotiated per-PO and must survive catalog changes.
 *   - Stock movement is applied at receipt time (NOT at PO submit) via
 *     delta_applied on the receipt line. Void contra-applies that delta.
 *   - QB sync uses two independent pipelines: PurchaseOrderAdd (header) and
 *     ItemReceiptAdd (per receipt). Both carry frozen JSON payloads for
 *     idempotent retries.
 */

import { Module } from "@medusajs/utils";

import PurchaseOrdersModuleService from "./service";

export const PURCHASE_ORDERS_MODULE = "purchase_orders";

export default Module(PURCHASE_ORDERS_MODULE, {
  service: PurchaseOrdersModuleService,
});
