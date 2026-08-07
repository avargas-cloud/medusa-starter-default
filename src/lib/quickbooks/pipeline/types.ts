export type PipelineStep =
  | "customer"
  | "estimate"
  | "estimate_mod"
  | "sales_order"
  | "sales_order_mod"
  | "sales_receipt"
  | "invoice"
  | "payment"
  | "apply_payment"
  | "credit_memo"
  | "write_check"
  | "refund_payment"
  | "refund_check_mod"
  | "refund_payment_txndate_change"
  | "refund_apply_del"
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
  // Borrado (TxnDel) de un ReceivePayment cuyo ADD seguía en vuelo cuando el
  // usuario voideó el pago. QuickBooks rechaza TxnVoid sobre ReceivePayment con
  // error 3110, así que quitarlo es borrarlo. Ver pipeline/void-intent.ts.
  | "void_payment"
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
  /**
   * Shallow-MERGE `payload` into whatever the row already carries instead of
   * REPLACING it (the default).
   *
   * Use this for narrow, partial enqueues — a caller that only knows about a
   * couple of header fields (sales rep, tax mode) must not clobber a broader
   * payload another caller staged. The concrete hazard: patch-meta enqueues a
   * `credit_memo_mod` carrying only salesRepRef/tax, and the credit_memo_mod
   * row is REUSED for a CM's whole life. Replacing meant a tax tweak landing on
   * a not-yet-dispatched edit silently dropped that edit's `items`, so the line
   * changes existed in Medusa and never reached QB. The window is one dispatch
   * tick normally — but it is unbounded while the row sits `failed` (CM-1087
   * sat failed for 14 days).
   *
   * Merge is shallow: incoming keys win, absent keys are preserved. Re-sending
   * an already-applied `items` array is harmless — a Mod is idempotent.
   */
  mergePayload?: boolean;
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
