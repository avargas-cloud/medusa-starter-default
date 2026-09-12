/**
 * src/lib/qb-backfill/qb-queries.ts
 *
 * Builders QBXML para los 6 requests de sólo lectura de este backfill.
 * Formas SONDEADAS contra el bridge real el 2026-09-11 (envelope completo por
 * `/api/sync/direct-query`; ver `qb-client.ts`):
 *
 *   PurchaseOrderQueryRq / ItemReceiptQueryRq / BillQueryRq / VendorCreditQueryRq
 *     → TxnDateRangeFilter + IncludeLineItems + IncludeLinkedTxns (statusCode 0).
 *
 *   BillPaymentCheckQueryRq / BillPaymentCreditCardQueryRq
 *     → TxnDateRangeFilter + IncludeLineItems SOLO (sin IncludeLinkedTxns:
 *       agregarlo devuelve 0x80040400 — sondeado y confirmado con control
 *       negativo). `IncludeLineItems=true` es lo que trae `AppliedToTxnRet[]`
 *       en este tipo de documento (no tiene líneas de ítem en el sentido
 *       usual; el nombre del flag es el mismo pero el efecto es distinto).
 *
 * Orden de elementos dentro del Rq = orden del DTD: TxnDateRangeFilter va
 * PRIMERO, después los flags Include*. Alterar el orden es la causa más común
 * de 0x80040400 (ver `.claude/skills/qb-query/SKILL.md`).
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

export function buildPurchaseOrderQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<PurchaseOrderQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</PurchaseOrderQueryRq>`
  );
}

export function buildItemReceiptQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<ItemReceiptQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</ItemReceiptQueryRq>`
  );
}

export function buildBillQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<BillQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</BillQueryRq>`
  );
}

export function buildVendorCreditQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<VendorCreditQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</VendorCreditQueryRq>`
  );
}

/**
 * `BillQueryRq` filtrado por una lista de `TxnID` (fase 3, de-adopt). QBXML
 * acepta múltiples `<TxnID>` dentro de un mismo `Rq` como filtro OR (mismo
 * patrón que `ItemQueryRq`/`VendorQueryRq` con varios `ListID`) — SONDEADO
 * contra el bridge real con 2 TxnIDs antes de usarse en el run completo (ver
 * reporte de la fase 3/4). Sin `TxnDateRangeFilter`: el TxnID ya identifica
 * el documento exacto, no hace falta acotar por fecha.
 */
export function buildBillByTxnIdsQbxml(txnIds: readonly string[]): string {
  if (txnIds.length === 0) throw new Error("buildBillByTxnIdsQbxml: lista de TxnID vacía");
  const ids = txnIds.map((id) => `<TxnID>${id}</TxnID>`).join("");
  return envelope(
    `<BillQueryRq requestID="1">${ids}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</BillQueryRq>`
  );
}

/**
 * `PurchaseOrderQueryRq` filtrado por una lista de `TxnID` (fase 2025-enlace,
 * `follow-links.ts`) — mismo patrón que `buildBillByTxnIdsQbxml`. SONDEADO
 * contra el bridge real con 2 TxnIDs + 1 control negativo (2026-09-11,
 * confirmado): igual que `BillQueryRq`, un `TxnID` inexistente en el lote
 * hace fallar el `Rs` ENTERO con statusCode 500 ("There was a required
 * element … that could not be found in QuickBooks") — no hay resultado
 * parcial. `follow-links.ts::fetchLinked` aplica el mismo fallback
 * por-TxnID-individual que ya usa `deadopt` en el script.
 */
export function buildPurchaseOrderByTxnIdsQbxml(txnIds: readonly string[]): string {
  if (txnIds.length === 0) throw new Error("buildPurchaseOrderByTxnIdsQbxml: lista de TxnID vacía");
  const ids = txnIds.map((id) => `<TxnID>${id}</TxnID>`).join("");
  return envelope(
    `<PurchaseOrderQueryRq requestID="1">${ids}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</PurchaseOrderQueryRq>`
  );
}

/**
 * `ItemReceiptQueryRq` filtrado por una lista de `TxnID` — mismo patrón y
 * mismo comportamiento SONDEADO (2026-09-11, confirmado) ante TxnID
 * inexistente que las dos anteriores: statusCode 500, `Rs` entero sin
 * resultado parcial.
 */
export function buildItemReceiptByTxnIdsQbxml(txnIds: readonly string[]): string {
  if (txnIds.length === 0) throw new Error("buildItemReceiptByTxnIdsQbxml: lista de TxnID vacía");
  const ids = txnIds.map((id) => `<TxnID>${id}</TxnID>`).join("");
  return envelope(
    `<ItemReceiptQueryRq requestID="1">${ids}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</ItemReceiptQueryRq>`
  );
}

/**
 * `VendorCreditQueryRq` por lista de `TxnID` (follow-links: un crédito de 2025
 * aplicado a un bill de 2026 seguía abierto al cierre — mismo criterio que un
 * bill aplicado por un pago del rango). Mismo patrón y mismo fallback 1x1.
 */
export function buildVendorCreditByTxnIdsQbxml(txnIds: readonly string[]): string {
  if (txnIds.length === 0) throw new Error("buildVendorCreditByTxnIdsQbxml: lista de TxnID vacía");
  const ids = txnIds.map((id) => `<TxnID>${id}</TxnID>`).join("");
  return envelope(
    `<VendorCreditQueryRq requestID="1">${ids}` +
      `<IncludeLineItems>true</IncludeLineItems><IncludeLinkedTxns>true</IncludeLinkedTxns>` +
      `</VendorCreditQueryRq>`
  );
}

export function buildBillPaymentCheckQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<BillPaymentCheckQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems>` +
      `</BillPaymentCheckQueryRq>`
  );
}

export function buildBillPaymentCreditCardQbxml(from: string, to: string): string {
  assertDate(from);
  assertDate(to);
  return envelope(
    `<BillPaymentCreditCardQueryRq requestID="1">${dateRangeFilter(from, to)}` +
      `<IncludeLineItems>true</IncludeLineItems>` +
      `</BillPaymentCreditCardQueryRq>`
  );
}

/**
 * Ventanas MENSUALES [from,to] inclusivas que cubren [from,to] (calendario,
 * no 30 días fijos: el mes de febrero no desperdicia días ni el de enero se
 * corta corto).
 */
export function* monthlyWindows(from: string, to: string): Generator<MonthlyWindow> {
  assertDate(from);
  assertDate(to);
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw new Error(`rango inválido: ${from}..${to}`);
  }
  const toIso = (d: Date) => d.toISOString().slice(0, 10);

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    const monthStart = new Date(Math.max(cursor.getTime(), start.getTime()));
    const monthEndRaw = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
    const monthEnd = new Date(Math.min(monthEndRaw.getTime(), end.getTime()));
    yield { from: toIso(monthStart), to: toIso(monthEnd) };
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
}
