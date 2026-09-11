/** qb-gl-import — superficie pública del importador QuickBooks → GL. Diseño: docs/QB_GL_IMPORT.md */
export * from "./types";
export { parseGeneralLedgerReport, verifyParsedTotals, parseCents, QbGlParseError } from "./parse-report";
export type { RawReportRet, TotalsMismatch } from "./parse-report";
export { classify, policyFor, POS_CUTOFF_DAY, POS_OWNED_TYPES, BANK_SIDE_TYPES } from "./classify";
export { assembleDocuments, MAX_LINES_PER_DOCUMENT } from "./assemble";
export { loadQbAccountIndex, missingAccounts } from "./accounts";
export { loadPosKnownTxnIds } from "./pos-links";
export type { QbAccountIndex } from "./accounts";
export {
  buildGeneralLedgerQbxml,
  reportWindows,
  fetchGeneralLedgerWindow,
  cachePathFor,
  QbGlBridgeError,
  GL_REPORT_COLUMNS,
} from "./report-client";
export type { FetchWindowOptions } from "./report-client";
export { toPostInput, postQbDocument, QB_IMPORT_SOURCE_KIND, QB_IMPORT_ACTOR, QbImportAccountError } from "./post";
export { qbMonthlyNet, compareMonthlyNet, monthlyKey, formatCents } from "./parity";
export type { ParityDiff } from "./parity";
