/**
 * src/lib/qb-backfill/sales-follow-links.ts
 *
 * Lado VENTAS de `follow-links.ts`: los invoices/credit memos de 2025 que
 * seguían abiertos al 31/12 no se barren por ventana mensual (fuera de
 * alcance por diseño), se traen SIGUIENDO los enlaces de los documentos de
 * 2026 ya descargados, por `TxnID` — mismo patrón, dos tipos en vez de
 * cuatro:
 *
 *   (a) `receive_payments[].applied[].txn_id` con `txn_type='Invoice'` y
 *       `txn_date < floorDate` → ese invoice seguía abierto al cierre.
 *   (b) `credit_memos[].linked_txns` de tipo `Invoice` bajo el piso — mismo
 *       razonamiento que un crédito de compras enlazado a un bill de 2025.
 *   (c) `receive_payments[].applied[].set_credits[].credit_txn_id` — un
 *       crédito que un pago del rango aplicó estaba vivo, SIN piso de fecha
 *       (mismo argumento que el crédito de vendor sobre un bill: si el
 *       rango lo referencia, existía).
 *
 * REGLA DURA: ningún `SalesReceipt` se trae de 2025 jamás — nace pagado, así
 * que no puede "seguir abierto"; `sales-queries.ts` ni siquiera expone un
 * builder con `IncludeLinkedTxns` para ese tipo.
 */
import { createHash } from "node:crypto";
import { directQuery } from "./qb-client";
import { buildCreditMemoByTxnIdsQbxml, buildInvoiceByTxnIdsQbxml } from "./sales-queries";
import { normalizeCreditMemos, normalizeInvoices } from "./sales-normalize";
import type { QbCreditMemo, QbInvoice, QbReceivePayment } from "./sales-types";

export interface SalesLinkableBucket {
  invoices: readonly QbInvoice[];
  credit_memos: readonly QbCreditMemo[];
  receive_payments: readonly QbReceivePayment[];
}

export interface KnownSalesTxnIdCache {
  invoices: ReadonlySet<string>;
  credit_memos: ReadonlySet<string>;
}

export interface MissingSalesLinks {
  invoices: string[];
  credit_memos: string[];
}

/**
 * `floorDate` (YYYY-MM-DD, típicamente el `--from` del import): un invoice
 * enlazado desde un pago/crédito del rango SÓLO se sigue si su fecha es
 * ANTERIOR al piso (si ya está en el rango, la ventana mensual ya lo trajo).
 * Los créditos vía `set_credits` se siguen SIN piso — el mismo razonamiento
 * que un `VendorCredit` aplicado a un bill de 2025 en el lado compras.
 */
export function collectMissingSalesLinks(
  bucket: SalesLinkableBucket,
  cache: KnownSalesTxnIdCache,
  floorDate: string
): MissingSalesLinks {
  const missingInvoices = new Set<string>();
  const missingCredits = new Set<string>();

  for (const payment of bucket.receive_payments) {
    for (const app of payment.applied) {
      if (
        app.txn_type === "Invoice" &&
        app.txn_date !== null &&
        app.txn_date < floorDate &&
        !cache.invoices.has(app.txn_id)
      ) {
        missingInvoices.add(app.txn_id);
      }
      for (const sc of app.set_credits) {
        if (!cache.credit_memos.has(sc.credit_txn_id)) missingCredits.add(sc.credit_txn_id);
      }
    }
  }
  for (const cm of bucket.credit_memos) {
    for (const lt of cm.linked_txns) {
      if (lt.txn_type === "Invoice" && lt.txn_date !== null && lt.txn_date < floorDate && !cache.invoices.has(lt.txn_id)) {
        missingInvoices.add(lt.txn_id);
      }
    }
  }
  return { invoices: [...missingInvoices], credit_memos: [...missingCredits] };
}

export interface FetchSalesLinkedOptions {
  cacheDir: string;
  pauseMs: number;
  log: (s: string) => void;
}

const BATCH = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `sha1` corto (10 hex) de la lista ORDENADA — determinístico, no depende de la posición del lote (idéntico a `follow-links.ts::hashIds`). */
function hashIds(ids: readonly string[]): string {
  return createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 10);
}

/**
 * Pide `txnIds` en lotes de `BATCH`. Un lote con UN TxnID inexistente falla
 * ENTERO: se reintenta 1x1 sólo para ESE lote (mismo fallback que
 * `follow-links.ts::fetchByTxnIdsWithFallback`).
 */
async function fetchByTxnIdsWithFallback<T>(
  txnIds: readonly string[],
  typeLabel: string,
  buildQbxml: (ids: readonly string[]) => string,
  rsKey: string,
  normalizeFn: (rs: Record<string, unknown> | null) => T[],
  opts: FetchSalesLinkedOptions
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < txnIds.length; i += BATCH) {
    const batch = txnIds.slice(i, i + BATCH);
    const key = `${typeLabel}_bytxn_${hashIds(batch)}`;
    try {
      const { rs } = await directQuery(buildQbxml(batch), rsKey, { cacheDir: opts.cacheDir, cacheKey: key, log: opts.log });
      out.push(...normalizeFn(rs));
    } catch (err) {
      opts.log(`  ${typeLabel} lote ${key} falló (${(err as Error).message.slice(0, 100)}) — reintentando 1x1`);
      for (const txnId of batch) {
        try {
          const singleKey = `${typeLabel}_bytxn_${hashIds([txnId])}`;
          const { rs } = await directQuery(buildQbxml([txnId]), rsKey, { cacheDir: opts.cacheDir, cacheKey: singleKey, log: opts.log });
          out.push(...normalizeFn(rs));
        } catch (err2) {
          opts.log(`    ${typeLabel} ${txnId}: ${(err2 as Error).message.slice(0, 100)}`);
        }
        if (opts.pauseMs > 0) await sleep(opts.pauseMs);
      }
    }
    if (opts.pauseMs > 0) await sleep(opts.pauseMs);
  }
  return out;
}

export interface FetchSalesLinkedResult {
  invoices: QbInvoice[];
  credit_memos: QbCreditMemo[];
}

/** Pide los TxnID de `missing` y normaliza con `via_link = true`. */
export async function fetchSalesLinked(missing: MissingSalesLinks, opts: FetchSalesLinkedOptions): Promise<FetchSalesLinkedResult> {
  const invoices = await fetchByTxnIdsWithFallback(
    missing.invoices,
    "invoice",
    buildInvoiceByTxnIdsQbxml,
    "InvoiceQueryRs",
    normalizeInvoices,
    opts
  );
  const credit_memos = await fetchByTxnIdsWithFallback(
    missing.credit_memos,
    "creditmemo",
    buildCreditMemoByTxnIdsQbxml,
    "CreditMemoQueryRs",
    normalizeCreditMemos,
    opts
  );
  return {
    invoices: invoices.map((i) => ({ ...i, via_link: true })),
    credit_memos: credit_memos.map((c) => ({ ...c, via_link: true })),
  };
}

export interface FollowSalesLinksMutableBucket {
  invoices: QbInvoice[];
  credit_memos: QbCreditMemo[];
  receive_payments: QbReceivePayment[];
}

export interface FollowSalesLinksReport {
  iterations: number;
  fetched_by_type: { invoices: number; credit_memos: number };
  fetched_by_year: Record<string, { invoices: number; credit_memos: number }>;
  fetched_txn_ids: { invoices: string[]; credit_memos: string[] };
}

function bumpYear(report: FollowSalesLinksReport, type: keyof FollowSalesLinksReport["fetched_by_type"], txnDate: string): void {
  const year = txnDate.slice(0, 4);
  const e = report.fetched_by_year[year] ?? { invoices: 0, credit_memos: 0 };
  e[type] += 1;
  report.fetched_by_year[year] = e;
}

/**
 * Orquesta `collectMissingSalesLinks` + `fetchSalesLinked` sobre el bucket
 * MUTABLE del script (push in-place, mismo patrón que `downloadSales`).
 * Corre ANTES de clasificar, tope `maxIterations` (default 5) — un invoice
 * de 2025 puede enlazar a un crédito que a su vez no enlaza a nada más.
 */
export async function followSalesLinks(
  bucket: FollowSalesLinksMutableBucket,
  opts: FetchSalesLinkedOptions & { maxIterations?: number; floorDate: string }
): Promise<FollowSalesLinksReport> {
  const maxIterations = opts.maxIterations ?? 5;
  const seenInvoices = new Set(bucket.invoices.map((i) => i.txn_id));
  const seenCredits = new Set(bucket.credit_memos.map((c) => c.txn_id));
  const report: FollowSalesLinksReport = {
    iterations: 0,
    fetched_by_type: { invoices: 0, credit_memos: 0 },
    fetched_by_year: {},
    fetched_txn_ids: { invoices: [], credit_memos: [] },
  };

  for (let i = 0; i < maxIterations; i++) {
    const missing = collectMissingSalesLinks(bucket, { invoices: seenInvoices, credit_memos: seenCredits }, opts.floorDate);
    if (missing.invoices.length === 0 && missing.credit_memos.length === 0) break;
    report.iterations++;
    opts.log(`  followSalesLinks iteración ${report.iterations}: invoice ${missing.invoices.length} · credit ${missing.credit_memos.length}`);

    // Marcados "vistos" ANTES de fetchear — un TxnID que QB no devuelve no debe re-pedirse en la próxima iteración.
    for (const id of missing.invoices) seenInvoices.add(id);
    for (const id of missing.credit_memos) seenCredits.add(id);

    const fetched = await fetchSalesLinked(missing, opts);
    for (const inv of fetched.invoices) {
      bucket.invoices.push(inv);
      bumpYear(report, "invoices", inv.txn_date);
      report.fetched_by_type.invoices++;
      report.fetched_txn_ids.invoices.push(inv.txn_id);
    }
    for (const cm of fetched.credit_memos) {
      bucket.credit_memos.push(cm);
      bumpYear(report, "credit_memos", cm.txn_date);
      report.fetched_by_type.credit_memos++;
      report.fetched_txn_ids.credit_memos.push(cm.txn_id);
    }
  }
  return report;
}
