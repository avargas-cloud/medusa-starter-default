export type PipelineStep =
  | "customer"
  | "estimate"
  | "sales_order"
  | "sales_receipt"
  | "invoice"
  | "payment"
  | "apply_payment"
  | "credit_memo"
  | "write_check"
  | "refund_payment"
  | "void_estimate"
  | "estimate_cancel"
  | "estimate_deactivate"
  | "void_invoice"
  | "void_sales_receipt"
  | "void_sales_order"
  | "invoice_update"
  | "sales_receipt_update"
  | "credit_memo_mod"
  | "void_credit_memo"
  | "void_check"
  | "payment_method_change"
  | "payment_txndate_change"
  | "transfer_customer"
  | "transfer_payment"
  | "so_close"
  | "so_reopen"
  | "vendor_bill_void"
  | "purchase_order"
  | "mod_purchase_order"
  | "void_purchase_order"
  | "inventory_adjustment"
  | "void_inventory_adjustment";

export type PipelineStatus =
  | "pending"
  | "processing"
  | "submitted"
  | "confirmed"
  | "failed"
  | "skipped"
  | "waiting" // POS 1-hour delay window — cron will process when time arrives
  | "manual" // qb_skip=true — order intentionally excluded from QB auto-sync
  | "synced"
  | "error"
  | "cancelled"
  | "voided";

export interface WritePipelineRowInput {
  orderId?: string | null;
  referenceId?: string | null;
  referenceType?: string | null;
  step: PipelineStep;
  status: PipelineStatus;
  dependsOn?: string | null;
  bridgeOpId?: string | null;
  retryCount?: number;
  qbTxnId?: string | null;
  /** QB-assigned reference number (e.g. "E18024677", "6241", "PAY-2016") — only known after QB confirms */
  qbRefNumber?: string | null;
  /** Medusa document number (e.g. "E1271", "S10065", "INV-20001", "PAY-2016") — known at creation time */
  medusaRefNumber?: string | null;
  qbResult?: object | null;
  payload?: object | null;
  error?: string | null;
  /**
   * Operation intent. Defaults to undefined = "add" (create a NEW QB document).
   *
   * Set to "mod" when this enqueue is meant to MODIFY an existing QB document
   * (e.g. SalesOrderMod / EstimateMod after a post-confirm edit). MOD is
   * idempotent on the bridge (it targets an existing TxnID + EditSequence), so a
   * "mod" pending write is ALLOWED to reactivate a confirmed row — unlike an ADD,
   * which stays a no-op to avoid minting a duplicate QB doc. A "mod" write REQUIRES
   * qbTxnId (the doc to modify); enqueuing "mod" without it throws. See the
   * QB_CREATE_STEPS guard in row-mutations.ts.
   */
  intent?: "mod";
}
