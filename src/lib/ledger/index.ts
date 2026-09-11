/** gl-core-v1 §5 — punto de entrada público del motor. */
export * from "./types";
export { loadAccountMap, loadOpeningAccountMap, loadPurchaseAccountMap, resolveProductAccounts } from "./accounts";
export {
  postDocumentJournal,
  reverseDocumentJournal,
  activeDocumentEntry,
} from "./post";
export { buildInvoiceLines } from "./lines/invoice";
export { buildCreditMemoLines, buildFraudWriteoffLines } from "./lines/credit-memo";
export { buildCustomerPaymentLines } from "./lines/customer-payment";
export { buildRoundingLines } from "./lines/rounding";
export { buildReceiptLines } from "./lines/receipt";
export { buildVendorBillLines } from "./lines/vendor-bill";
export type { VendorBillClassifiedLine } from "./lines/vendor-bill";
export { buildVendorCreditLines } from "./lines/vendor-credit";
export type { VendorCreditAccountLine } from "./lines/vendor-credit";
export { buildBillPaymentLines } from "./lines/bill-payment";
export { buildOpeningBalanceLines } from "./lines/opening-balance";
export type {
  OpeningBalanceInput,
  OpeningBalanceItem,
  OpeningBalanceItemKind,
} from "./lines/opening-balance";
export { postInvoice, reverseInvoice } from "./documents/invoice";
export { postCreditMemo, reverseCreditMemo } from "./documents/credit-memo";
export {
  postCustomerPayment,
  reverseCustomerPayment,
} from "./documents/customer-payment";
export {
  postRoundingAdjustment,
  reverseRoundingAdjustment,
} from "./documents/rounding";
export { postReceipt, reverseReceipt } from "./documents/receipt";
export {
  postVendorBill,
  reverseVendorBill,
  postOrRepostVendorBill,
  currentVendorBillSourceHash,
  computeVendorBillSourceHash,
} from "./documents/vendor-bill";
export { postVendorCredit, reverseVendorCredit } from "./documents/vendor-credit";
export { postBillPayment, reverseBillPayment } from "./documents/bill-payment";
export {
  postOpeningBalance,
  reverseOpeningBalance,
  listOpeningBalances,
  OPENING_BALANCE_ACCOUNT_TYPES,
} from "./documents/opening-balance";
export type {
  PostOpeningBalanceInput,
  OpeningBalanceListItem,
} from "./documents/opening-balance";
export { replayLedger } from "./replay";
export type { ReplayOptions, ReplayReport, ReplayCounts, ReplayBlock } from "./replay";
export {
  centsFromNumeric,
  costCentsHalfUp,
  absBigInt,
  signedLine,
  centsToDollarsString,
} from "./money";
export { reconcilePurchaseDrift } from "./drift";
export type { DriftReport } from "./drift";
