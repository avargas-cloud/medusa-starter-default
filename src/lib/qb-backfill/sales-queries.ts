/**
 * src/lib/qb-backfill/sales-queries.ts
 *
 * Builders QBXML para el lado VENTAS del backfill: Invoice, SalesReceipt,
 * ReceivePayment, CreditMemo — mismo envelope y mismas convenciones de orden
 * de elementos que `qb-queries.ts` (compras). Orden de elementos = orden del
 * DTD qbxml (13.0/16.0):
 *
 *   InvoiceQueryRq / SalesReceiptQueryRq / CreditMemoQueryRq
 *     → TxnDateRangeFilter → IncludeLineItems → IncludeLinkedTxns
 *
 *   InvoiceQueryRq con `PaidStatus` (variante "unpaid only"):
 *     → TxnDateRangeFilter → PaidStatus → IncludeLineItems → IncludeLinkedTxns
 *     (PaidStatus va DESPUÉS del filtro de fecha, mismo lugar que en
 *     `BillQueryRq` — ver `buildBillUnpaidQbxml`).
 *
 *   ReceivePaymentQueryRq
 *     → TxnDateRangeFilter → IncludeLineItems SOLO. `IncludeLineItems=true`
 *     es lo que trae `AppliedToTxnRet[]` en este documento (no tiene línea
 *     de ítem en el sentido usual — mismo comportamiento de nombre-mismo/
 *     efecto-distinto que `BillPaymentCheckQueryRq` en `qb-queries.ts`).
 *     `IncludeLinkedTxns` NO es válido acá — no se emite.
 *
 * DUDA DE ORDEN (sin sondear contra el bridge real en esta fase — código +
 * unit tests únicamente, ver spec del task): el DTD de `InvoiceQueryRq`
 * ubica `PaidStatus` inmediatamente después de `TxnDateRangeFilter` y antes
 * de cualquier otro filtro (mismo patrón ya sondeado y documentado para
 * `BillQueryRq` en `qb-queries.ts`/`apply-purchases.ts`). Se replica ese
 * orden por analogía; falta sondear contra el bridge real antes de usarse
 * en un run de producción.
 */

import type { MonthlyWindow } from "./types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(d: string): void {
  if (!DATE_RE.test(d)) throw new Error(`fecha inválida: ${d}`);
}

function envelope(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>` +
    `<QBXML><QBXMLMsgsRq onError="stopOnError">${body}</QBXMLMsgsRq></QBXML>`
  );
}

function dateRangeFilter(from: string, to: string): string {
  return `<TxnDateRangeFilter><FromTxnDate>${from}</FromTxnDate><ToTxnDate>${to}</ToTxnDate></TxnDateRangeFilter>`;
}

export function buildInvoiceQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<InvoiceQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</InvoiceQueryRq>`
  );
}

/**
 * Sin `IncludeLinkedTxns`: `SalesReceiptQueryRq` NO lo admite — QB devuelve
 * 0x80040400 "error when parsing the provided XML text stream" (sondeado contra
 * el bridge real el 2026-09-11). Un sales receipt nace pagado: no enlaza nada.
 */
export function buildSalesReceiptQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<SalesReceiptQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems>` +
      `</SalesReceiptQueryRq>`
  );
}

export function buildCreditMemoQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<CreditMemoQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</CreditMemoQueryRq>`
  );
}

/**
 * `ReceivePaymentQueryRq` — SIN `IncludeLinkedTxns` (no es un flag válido
 * para este tipo de documento). `IncludeLineItems` es lo que trae
 * `AppliedToTxnRet[]`.
 */
export function buildReceivePaymentQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<ReceivePaymentQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems>` +
      `</ReceivePaymentQueryRq>`
  );
}

/**
 * `InvoiceQueryRq` filtrado por `PaidStatus=NotPaidOnly` (mismo lugar en el
 * DTD que `PaidStatus` en `BillQueryRq` — ver `buildBillUnpaidQbxml`):
 * TxnDateRangeFilter → PaidStatus → IncludeLineItems → IncludeLinkedTxns.
 */
export function buildInvoiceUnpaidQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<InvoiceQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<PaidStatus>NotPaidOnly</PaidStatus>` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</InvoiceQueryRq>`
  );
}

/**
 * `BillQueryRq` filtrado por `PaidStatus=NotPaidOnly` — mismo shape que
 * `buildInvoiceUnpaidQbxml`, para el lado compras (`BillQueryRq` normal en
 * `qb-queries.ts` no expone esta variante).
 */
export function buildBillUnpaidQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<BillQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<PaidStatus>NotPaidOnly</PaidStatus>` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</BillQueryRq>`
  );
}

function byTxnIds(txnIds: readonly string[], tag: string, includeLinkedTxns: boolean): string {
  if (txnIds.length === 0) throw new Error(`build${tag}ByTxnIdsQbxml: lista de TxnID vacía`);
  const ids = txnIds.map((id) => `<TxnID>${id}</TxnID>`).join("");
  const linked = includeLinkedTxns ? `<IncludeLinkedTxns>true</IncludeLinkedTxns>` : "";
  return envelope(
    `<${tag}QueryRq requestID="1">${ids}` +
      `<IncludeLineItems>true</IncludeLineItems>${linked}` +
      `</${tag}QueryRq>`
  );
}

export function buildInvoiceByTxnIdsQbxml(txnIds: readonly string[]): string {
  return byTxnIds(txnIds, "Invoice", true);
}

export function buildCreditMemoByTxnIdsQbxml(txnIds: readonly string[]): string {
  return byTxnIds(txnIds, "CreditMemo", true);
}

/** Sin `IncludeLinkedTxns` — `SalesReceiptQueryRq` no lo admite (0x80040400 sondeado el 2026-09-11). */
export function buildSalesReceiptByTxnIdsQbxml(txnIds: readonly string[]): string {
  return byTxnIds(txnIds, "SalesReceipt", false);
}

/** Sin `IncludeLinkedTxns` — no válido para `ReceivePaymentQueryRq` (ver arriba). */
export function buildReceivePaymentByTxnIdsQbxml(txnIds: readonly string[]): string {
  return byTxnIds(txnIds, "ReceivePayment", false);
}

export const SALES_RS_KEYS: Record<
  "invoice" | "sales_receipt" | "receive_payment" | "credit_memo",
  string
> = {
  invoice: "InvoiceQueryRs",
  sales_receipt: "SalesReceiptQueryRs",
  receive_payment: "ReceivePaymentQueryRs",
  credit_memo: "CreditMemoQueryRs",
};

export const SALES_RET_KEYS: Record<
  "invoice" | "sales_receipt" | "receive_payment" | "credit_memo",
  string
> = {
  invoice: "InvoiceRet",
  sales_receipt: "SalesReceiptRet",
  receive_payment: "ReceivePaymentRet",
  credit_memo: "CreditMemoRet",
};

export { monthlyWindows } from "./qb-queries";
export type { MonthlyWindow };
