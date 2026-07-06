// ─── Types ────────────────────────────────────────────────────────────────────

export interface QbOrderItem {
  productId?: string;
  productName?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  unitOfMeasure?: string;
  desc?: string;
  noSite?: boolean;
  /** QB item classification copied from variant metadata. Non-inventory types must not emit InventorySiteRef. */
  qbItemType?: string;
  /**
   * Per-line tax flag. When false, the bridge emits `<SalesTaxCodeRef>Non</...>`
   * so QB doesn't tax this line. Default (omitted) → taxable.
   */
  taxable?: boolean;
  /**
   * For *Mod operations only. Use the TxnLineID from an existing QB line
   * (as returned by InvoiceQuery/SalesReceiptQuery) to update that line,
   * or "-1" to append a new line. Omit for *Add operations.
   */
  TxnLineID?: string;
}

export interface QbCreateCustomerPayload {
  Name: string;
  FirstName?: string;
  LastName?: string;
  CompanyName?: string;
  Email?: string;
  Phone?: string;
  BillAddress?: {
    Addr1?: string;
    City?: string;
    State?: string;
    PostalCode?: string;
  };
  ShipAddress?: {
    Addr1?: string;
    City?: string;
    State?: string;
    PostalCode?: string;
  };
  CustomerType?: string;
  PriceLevel?: string;
  AltContact?: string; // Native QB "Alt. Contact" field (Address Info tab)
  AltPhone?: string; // Native QB "Alt. Phone" field (Address Info tab)
  // Note: Cc is NOT valid in QBXML 10.0 — stored in Medusa metadata only
}

export interface QbUpdateCustomerPayload extends Omit<
  QbCreateCustomerPayload,
  "Name"
> {
  Name: string; // QB customer name (must match existing record)
  ListID: string; // QB ListID from metadata.qb_list_id
  EditSequence: string; // QB EditSequence (obtained via CustomerQuery)
}

export interface QbCreateSalesOrderPayload {
  customerId: string;
  date: string;
  items: QbOrderItem[];
  memo?: string;
  poNumber?: string;
  refNumber?: string;
  taxExempt?: boolean;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  salesRep?: string;
}

export interface QbUpdateSalesOrderPayload {
  txnId: string;
  customerId?: string;
  customerName?: string;
  items: QbOrderItem[];
  memo?: string;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  taxExempt?: boolean;
  salesRep?: string;
}

export interface QbConvertEstimatePayload {
  estimateTxnId: string;
  customerId: string;
  date?: string;
  items: QbOrderItem[];
  memo?: string;
  taxExempt?: boolean;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
}

export interface QbReceivePaymentPayload {
  customerId: string;
  amount: number | string;
  /** YYYY-MM-DD business date → QB <TxnDate>. When omitted, QB stamps the txn
   * with the QB Desktop machine's system-clock date at process time. Always
   * pass the real payment date so QB stays synced with the POS. */
  date?: string;
  paymentMethod?: string;
  memo?: string;
  refNumber?: string;
  autoApply?: boolean;
  invoiceId?: string;
  creditTxnId?: string;
  depositAccount?: string;
}

export interface QbCreateInvoicePayload {
  customerId: string;
  date?: string;
  LinkToTxnID?: string;
  refNumber?: string;
  memo?: string;
  items?: QbOrderItem[];
  taxExempt?: boolean;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  salesRep?: string;
}

export interface QbCreateCreditMemoPayload {
  customerId: string;
  date?: string;
  refNumber?: string;
  memo?: string;
  items?: QbOrderItem[];
  taxExempt?: boolean;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  salesRepRef?: string;
  /**
   * Idempotency key forwarded to the bridge. A re-sent create with the same key
   * returns the existing bridge op instead of minting a duplicate QB Credit Memo.
   * Convention: `credit-memo:<pos_credit_memo.id>`.
   */
  idempotencyKey?: string;
}

export interface QbUpdateCreditMemoPayload {
  txnId: string;
  editSequence: string;
  salesRepRef?: string;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  taxExempt?: boolean;
  memo?: string;
  /** Customer override (ListID). Optional — defaults to original customer. */
  customerId?: string;
  /** Transaction date (YYYY-MM-DD). Optional override. */
  date?: string;
  /** Document RefNumber override. Optional. */
  refNumber?: string;
  /**
   * Full line replacement. Existing lines with their TxnLineID + "-1" for new.
   * Lines from the original CM not included here are deleted by QB.
   */
  items?: QbOrderItem[];
}

export interface QbUpdateInvoicePayload {
  txnId: string;
  salesRep?: string;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  taxExempt?: boolean;
  memo?: string;
  items?: QbOrderItem[];
}

export interface QbUpdateSalesReceiptPayload {
  txnId: string;
  salesRep?: string;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  taxExempt?: boolean;
  memo?: string;
  paymentMethod?: string; // QB FullName (e.g., 'Visa', 'MasterCard', 'Cash')
  items?: QbOrderItem[];
}

export interface QbCreateEstimatePayload {
  customerId: string;
  date: string;
  items: QbOrderItem[];
  memo?: string;
  poNumber?: string;
  refNumber?: string;
  taxExempt?: boolean;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  salesRep?: string;
}

export interface QbUpdateEstimatePayload {
  txnId: string;
  items: QbOrderItem[];
  memo?: string;
  taxExempt?: boolean;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  isActive?: boolean;
  salesRep?: string;
}

export interface QbCreateSalesReceiptPayload {
  customerId: string;
  refNumber?: string;
  items: QbOrderItem[];
  paymentMethod?: string;
  salesRep?: string;
  salesTaxCode?: string;
  /** QB SalesTaxItem ListID — when present, bridge emits ItemSalesTaxRef.ListID instead of FullName. */
  qbTaxItemListid?: string;
  date?: string;
  memo?: string;
}

export interface QbCreateCheckPayload {
  customerId: string; // QB ListID of the customer (payee)
  bankAccountListId: string; // QB ListID of the bank account to draw from
  amount: number; // dollars (not cents)
  date?: string; // ISO date string (YYYY-MM-DD)
  refNumber?: string; // human-readable reference (e.g. "CM-20045")
  memo?: string; // check memo
  expenseAccountName?: string; // QB FullName of expense account (default: "Accounts Receivable")
}

export interface QbAsyncResult {
  operationId: string;
  txnId?: string;
  refNumber?: string;
  listId?: string; // Customer operations return listId (QB ListID) instead of txnId
  editSequence?: string;
}

export interface QbBridgeResult<T = any> {
  success: boolean;
  data?: T;
  dryRun?: boolean;
  error?: string;
}
