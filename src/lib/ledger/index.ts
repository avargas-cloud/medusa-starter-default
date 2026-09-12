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
export { buildJournalEntryLines } from "./lines/journal-entry";
export type { JournalEntryLineInput as JournalEntryBuilderLine } from "./lines/journal-entry";
export { buildBankCheckLines, deriveBankCheckKind, bankCheckTotal } from "./lines/bank-check";
export type { BankCheckKind } from "./lines/bank-check";
export { buildBankTransferLines, TRANSFER_ACCOUNT_TYPES } from "./lines/bank-transfer";
export { computeYearClose, YEAR_CLOSE_ACCOUNT_TYPES } from "./lines/year-close";
export type { YearCloseBalance, YearCloseComputation } from "./lines/year-close";
export {
  createJournalEntry,
  updateJournalEntry,
  getJournalEntry,
  listJournalEntries,
  postJournalEntry,
  voidJournalEntry,
} from "./documents/journal-entry";
export type {
  JournalEntryDto,
  JournalEntryLineDto,
  JournalEntryWriteInput,
  PostGlDocumentResult,
} from "./documents/journal-entry";
export {
  createBankCheck,
  updateBankCheck,
  getBankCheck,
  listBankChecks,
  postBankCheck,
  voidBankCheck,
} from "./documents/bank-check";
export type { BankCheckDto, BankCheckLineDto, BankCheckWriteInput, CheckPayeeType } from "./documents/bank-check";
export {
  createBankTransfer,
  getBankTransfer,
  listBankTransfers,
  postBankTransfer,
  voidBankTransfer,
} from "./documents/bank-transfer";
export type { BankTransferDto, BankTransferWriteInput } from "./documents/bank-transfer";
export {
  previewYearClose,
  postYearClose,
  reverseYearClose,
  loadYearBalances,
  yearCloseDay,
  YEAR_RE,
} from "./documents/year-close";
export type { YearClosePreview, YearCloseAccountPreview } from "./documents/year-close";
export type { ListFilters, ListPage } from "./documents/manual-list";
export type { AccountSnapshot, GlDocumentStatus } from "./documents/manual-shared";
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
