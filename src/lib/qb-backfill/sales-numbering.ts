/**
 * src/lib/qb-backfill/sales-numbering.ts
 *
 * Numeración de los documentos de VENTAS que trae el backfill de QB
 * (plan 2, `qb-sales-backfill-20260911`). Misma política que los POs de
 * compras (`create-po.ts`): un documento ANTERIOR al go-live del POS
 * (`POS_GO_LIVE_DATE`, 2026-04-14) es "histórico" y toma un rango propio,
 * por debajo de todo lo que el POS numeró, sin consumir las secuencias
 * vivas:
 *
 *   orden        S0001..S9999    (los del POS arrancan en S10006)
 *   factura      00001..09999    (las del POS arrancan en 20003)
 *   credit memo  CM-0001..CM-0999 (los del POS arrancan en CM-1000)
 *
 * El siguiente número histórico es `max(rango vivo) + 1` — en orden de
 * creación, que es cronológico porque el script recorre ventanas mensuales.
 * Un documento en o después del go-live es corriente y toma la numeración
 * normal: `custom_order_seq`, el counter ROW `medusa_invoice`
 * (`allocateNextNumber`, gapless) y `custom_credit_memo_seq`.
 *
 * Sólo se cuentan filas VIVAS (`deleted_at IS NULL`): un rollback por
 * marcador soft-borra y la re-aplicación debe reproducir los mismos números.
 */
import { allocateNextNumber, type TxManager } from "../invoices/document-numbering";
import { POS_GO_LIVE_DATE } from "./create-po";
import type { QueryableDb } from "./resolve";

/**
 * Rangos históricos. Órdenes e invoices comparten el volumen ene–abr13 2026
 * (387 invoices + 823 sales receipts = 1.210 órdenes) → 4 dígitos no
 * alcanzan (se agotó S0999 en la primera corrida real): S0001..S9999 y
 * 00001..09999, que siguen ordenando ANTES de los del POS (S10006 / 20003)
 * tanto numérica como lexicográficamente. Credit memos: 108 → CM-0001..CM-0999
 * (los del POS arrancan en CM-1000, así que ahí el tope sí es 999).
 */
export const HISTORICAL_RANGE_MAX = 9999;
export const HISTORICAL_CM_RANGE_MAX = 999;

export function isHistoricalSalesDate(txnDate: string, goLiveDate: string = POS_GO_LIVE_DATE): boolean {
  return txnDate < goLiveDate;
}

export function formatHistoricalOrderNumber(n: number): string {
  return `S${String(n).padStart(4, "0")}`;
}

export function formatHistoricalInvoiceNumber(n: number): string {
  return String(n).padStart(5, "0");
}

export function formatHistoricalCreditMemoNumber(n: number): string {
  return `CM-${String(n).padStart(4, "0")}`;
}

function assertInRange(kind: string, n: number, max: number = HISTORICAL_RANGE_MAX): number {
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${kind}: se agotó el rango histórico 1..${max} (siguiente = ${n})`);
  }
  return n;
}

function firstNumber(rows: Record<string, unknown>[], key: string): number {
  const v = rows[0]?.[key];
  return Number(v ?? 0);
}

/** `S0001`… antes del go-live; `S<nextval('custom_order_seq')>` después. */
export async function allocateOrderDocumentNumber(
  client: QueryableDb,
  txnDate: string,
  goLiveDate: string = POS_GO_LIVE_DATE
): Promise<string> {
  if (isHistoricalSalesDate(txnDate, goLiveDate)) {
    const { rows } = await client.query(
      `SELECT coalesce(max(substring(metadata->>'document_number' from 2)::int), 0) + 1 AS n
         FROM "order"
        WHERE deleted_at IS NULL AND metadata->>'document_number' ~ '^S[0-9]{4}$'`
    );
    return formatHistoricalOrderNumber(assertInRange("order", firstNumber(rows, "n")));
  }
  const { rows } = await client.query(`SELECT nextval('custom_order_seq') AS n`);
  return `S${firstNumber(rows, "n")}`;
}

/** `00001`… antes del go-live; counter row `medusa_invoice` (gapless) después. */
export async function allocateInvoiceNumber(
  client: QueryableDb,
  txnDate: string,
  goLiveDate: string = POS_GO_LIVE_DATE
): Promise<string> {
  if (isHistoricalSalesDate(txnDate, goLiveDate)) {
    const { rows } = await client.query(
      `SELECT coalesce(max(invoice_number::int), 0) + 1 AS n
         FROM pos_invoice
        WHERE deleted_at IS NULL AND invoice_number ~ '^0[0-9]{4}$'`
    );
    return formatHistoricalInvoiceNumber(assertInRange("invoice", firstNumber(rows, "n")));
  }
  return String(await allocateNextNumber(txManagerFor(client), "medusa_invoice"));
}

/** `CM-0001`… antes del go-live; `CM-<nextval('custom_credit_memo_seq')>` después. */
export async function allocateCreditMemoNumber(
  client: QueryableDb,
  txnDate: string,
  goLiveDate: string = POS_GO_LIVE_DATE
): Promise<string> {
  if (isHistoricalSalesDate(txnDate, goLiveDate)) {
    const { rows } = await client.query(
      `SELECT coalesce(max(substring(credit_memo_number from 4)::int), 0) + 1 AS n
         FROM pos_credit_memo
        WHERE deleted_at IS NULL AND credit_memo_number ~ '^CM-0[0-9]{3}$'`
    );
    return formatHistoricalCreditMemoNumber(assertInRange("credit_memo", firstNumber(rows, "n"), HISTORICAL_CM_RANGE_MAX));
  }
  const { rows } = await client.query(`SELECT nextval('custom_credit_memo_seq') AS n`);
  return `CM-${firstNumber(rows, "n")}`;
}

/** `display_id` de `customer_payment`: siempre la secuencia viva (no hay rango histórico para pagos). */
export async function allocatePaymentDisplayId(client: QueryableDb): Promise<number> {
  const { rows } = await client.query(`SELECT nextval('custom_payment_seq') AS n`);
  return firstNumber(rows, "n");
}

/**
 * Adapta un `QueryableDb` (placeholders `$1`) al `TxManager` que espera
 * `allocateNextNumber` (placeholders `?` de knex). El helper usa UN solo `?`.
 */
export function txManagerFor(client: QueryableDb): TxManager {
  return {
    async execute<T = unknown>(sql: string, params?: unknown[]): Promise<T> {
      let i = 0;
      const converted = sql.replace(/\?/g, () => `$${++i}`);
      const { rows } = await client.query(converted, params);
      return rows as unknown as T;
    },
  };
}
