/**
 * src/lib/qb-backfill/follow-links.ts
 *
 * Paso "2025 por ENLACE" del plan `qb-docs-backfill-compras-20260911`: los
 * documentos de 2025 que seguían abiertos al 31/12 no se barren por ventana
 * mensual (fuera de alcance por diseño), se traen SIGUIENDO los enlaces de
 * los documentos de 2026 ya descargados, por `TxnID`.
 *
 * `collectMissingLinks` es PURO (sin IO) — lee el bucket ya normalizado y una
 * caché de TxnIDs ya vistos, y devuelve qué falta pedir. `fetchLinked` hace el
 * IO (consulta al bridge, con el mismo fallback por-TxnID-individual que
 * `deadopt` en `backfill-qb-purchases.ts` cuando el lote entero falla por un
 * TxnID inexistente — sondeado idéntico para PO/ItemReceipt/Bill, ver
 * `qb-queries.ts`). `followLinks` orquesta ambos, iterando hasta que no
 * aparezcan enlaces nuevos (tope `maxIterations`, default 5): un bill de 2025
 * puede enlazar a un PO de 2025 que a su vez no enlaza a nada más.
 */
import { createHash } from "node:crypto";
import { directQuery } from "./qb-client";
import {
  buildBillByTxnIdsQbxml,
  buildItemReceiptByTxnIdsQbxml,
  buildPurchaseOrderByTxnIdsQbxml,
  buildVendorCreditByTxnIdsQbxml,
} from "./qb-queries";
import { normalizeBills, normalizeItemReceipts, normalizePurchaseOrders, normalizeVendorCredits } from "./normalize";
import { linkedTxnIdsOfType } from "./links";
import type { QbBill, QbBillPayment, QbItemReceipt, QbPurchaseOrder, QbVendorCredit } from "./types";

export interface LinkableBucket {
  bills: readonly QbBill[];
  item_receipts: readonly QbItemReceipt[];
  purchase_orders: readonly QbPurchaseOrder[];
  bill_payments: readonly QbBillPayment[];
  /** Un crédito del rango aplicado a un bill = ese bill seguía abierto al inicio del rango (misma regla que un pago). */
  vendor_credits?: readonly QbVendorCredit[];
}

/** TxnIDs ya presentes (del rango o de una iteración previa) — no se re-piden. */
export interface KnownTxnIdCache {
  bills: ReadonlySet<string>;
  purchase_orders: ReadonlySet<string>;
  item_receipts: ReadonlySet<string>;
  vendor_credits?: ReadonlySet<string>;
}

export interface MissingLinks {
  bills: string[];
  purchase_orders: string[];
  item_receipts: string[];
  vendor_credits: string[];
}

/**
 * De `bill_payments`: bills aplicados que no están en `cache.bills`. De
 * bills+recibos: POs enlazados que no están en `cache.purchase_orders`. De
 * bills: recibos enlazados que no están en `cache.item_receipts`.
 */
/**
 * `floorDate` (YYYY-MM-DD, típicamente el `--from` del import): un RECIBO anterior al piso NUNCA se
 * sigue — pertenece a los libros del año cerrado y el inventario de apertura ya lo tiene (regla del
 * operador 2026-09-11: "no pueden haber receipts en 2025"). Un BILL anterior al piso sólo entra si un
 * pago posterior lo aplica (seguía abierto al cierre); desde un PO no se siguen bills anteriores.
 * Los POs se siguen sin piso: si un documento del rango los enlaza, estaban vivos.
 */
export function collectMissingLinks(bucket: LinkableBucket, cache: KnownTxnIdCache, floorDate?: string): MissingLinks {
  const afterFloor = (d: string | null): boolean => !floorDate || (d !== null && d >= floorDate);
  const missingBills = new Set<string>();
  const missingPos = new Set<string>();
  const missingReceipts = new Set<string>();
  const missingCredits = new Set<string>();

  for (const payment of bucket.bill_payments) {
    for (const app of payment.applications) {
      if (app.txn_type === "Bill" && !cache.bills.has(app.txn_id)) missingBills.add(app.txn_id);
    }
  }
  // Un bill "pagado" con un crédito no tiene BillPayment en QB: el enlace vive en el
  // VendorCredit (LinkedTxn TxnType=Bill). Medido 2026-09-11: 35 bills de 2025 cerrados
  // por créditos de 2026 quedaban fuera (y sus aplicaciones, sin bill destino).
  for (const credit of bucket.vendor_credits ?? []) {
    for (const txnId of linkedTxnIdsOfType(credit.linked_txns, "Bill")) {
      if (!cache.bills.has(txnId)) missingBills.add(txnId);
    }
  }
  for (const doc of [...bucket.bills, ...bucket.item_receipts]) {
    for (const txnId of linkedTxnIdsOfType(doc.linked_txns, "PurchaseOrder")) {
      if (!cache.purchase_orders.has(txnId)) missingPos.add(txnId);
    }
  }
  for (const bill of bucket.bills) {
    for (const lt of bill.linked_txns) {
      if (lt.txn_type === "ItemReceipt" && afterFloor(lt.txn_date) && !cache.item_receipts.has(lt.txn_id)) missingReceipts.add(lt.txn_id);
      // Un crédito aplicado a un bill del rango seguía abierto al inicio del rango: se sigue SIN piso
      // (medido 2026-09-11: 2 créditos de 2025 aplicados a bills de 2026 quedaban fuera).
      if (lt.txn_type === "VendorCredit" && cache.vendor_credits && !cache.vendor_credits.has(lt.txn_id)) missingCredits.add(lt.txn_id);
    }
  }
  // Y en la dirección inversa: un PO traído por enlace (típicamente de 2025) lista en su
  // `LinkedTxn` los recibos y bills que lo recibieron; si están fuera del rango descargado
  // el PO queda "recibido" sin ningún recibo en el POS (medido 2026-09-11: 23 de 32 POs de
  // 2025). Se piden por TxnID igual que el resto.
  for (const po of bucket.purchase_orders) {
    for (const lt of po.linked_txns) {
      if (!afterFloor(lt.txn_date)) continue;
      if (lt.txn_type === "ItemReceipt" && !cache.item_receipts.has(lt.txn_id)) missingReceipts.add(lt.txn_id);
      if (lt.txn_type === "Bill" && !cache.bills.has(lt.txn_id)) missingBills.add(lt.txn_id);
    }
  }
  return { bills: [...missingBills], purchase_orders: [...missingPos], item_receipts: [...missingReceipts], vendor_credits: [...missingCredits] };
}

export interface FetchLinkedOptions {
  cacheDir: string;
  pauseMs: number;
  log: (s: string) => void;
}

const BATCH = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `sha1` corto (10 hex) de la lista ORDENADA — determinístico, no depende de la posición del lote. */
function hashIds(ids: readonly string[]): string {
  return createHash("sha1").update([...ids].sort().join(",")).digest("hex").slice(0, 10);
}

/**
 * Pide `txnIds` en lotes de `BATCH`. Un lote con UN TxnID inexistente falla
 * ENTERO (statusCode 500, sondeado — ver `qb-queries.ts`): se reintenta
 * 1x1 sólo para ESE lote, igual que el de-adopt del script.
 */
async function fetchByTxnIdsWithFallback<T>(
  txnIds: readonly string[],
  typeLabel: string,
  buildQbxml: (ids: readonly string[]) => string,
  rsKey: string,
  normalizeFn: (rs: Record<string, unknown> | null) => T[],
  opts: FetchLinkedOptions
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

export interface FetchLinkedResult {
  bills: QbBill[];
  purchase_orders: QbPurchaseOrder[];
  item_receipts: QbItemReceipt[];
  vendor_credits: QbVendorCredit[];
}

/** Pide los TxnID de `missing` y normaliza con `via_link = true`. */
export async function fetchLinked(missing: MissingLinks, opts: FetchLinkedOptions): Promise<FetchLinkedResult> {
  const bills = await fetchByTxnIdsWithFallback(missing.bills, "bill", buildBillByTxnIdsQbxml, "BillQueryRs", normalizeBills, opts);
  const purchase_orders = await fetchByTxnIdsWithFallback(
    missing.purchase_orders,
    "po",
    buildPurchaseOrderByTxnIdsQbxml,
    "PurchaseOrderQueryRs",
    normalizePurchaseOrders,
    opts
  );
  const item_receipts = await fetchByTxnIdsWithFallback(
    missing.item_receipts,
    "receipt",
    buildItemReceiptByTxnIdsQbxml,
    "ItemReceiptQueryRs",
    normalizeItemReceipts,
    opts
  );
  const vendor_credits = await fetchByTxnIdsWithFallback(
    missing.vendor_credits,
    "credit",
    buildVendorCreditByTxnIdsQbxml,
    "VendorCreditQueryRs",
    normalizeVendorCredits,
    opts
  );
  return {
    bills: bills.map((b) => ({ ...b, via_link: true })),
    purchase_orders: purchase_orders.map((p) => ({ ...p, via_link: true })),
    item_receipts: item_receipts.map((r) => ({ ...r, via_link: true })),
    vendor_credits: vendor_credits.map((c) => ({ ...c, via_link: true })),
  };
}

export interface FollowLinksMutableBucket {
  purchase_orders: QbPurchaseOrder[];
  item_receipts: QbItemReceipt[];
  bills: QbBill[];
  bill_payments: QbBillPayment[];
  vendor_credits?: QbVendorCredit[];
}

export interface FollowLinksReport {
  iterations: number;
  fetched_by_type: { bills: number; purchase_orders: number; item_receipts: number; vendor_credits: number };
  fetched_by_year: Record<string, { bills: number; purchase_orders: number; item_receipts: number; vendor_credits: number }>;
  /**
   * TxnIDs efectivamente traídos por enlace — el verificador los necesita
   * para distinguir "fetched pero YA conocido" (no se crea nada, 0 marcados
   * via_link es correcto) de "fetched y creado sin su marcador" (bug real).
   */
  fetched_txn_ids: { bills: string[]; purchase_orders: string[]; item_receipts: string[]; vendor_credits: string[] };
}

function bumpYear(report: FollowLinksReport, type: keyof FollowLinksReport["fetched_by_type"], txnDate: string): void {
  const year = txnDate.slice(0, 4);
  const e = report.fetched_by_year[year] ?? { bills: 0, purchase_orders: 0, item_receipts: 0, vendor_credits: 0 };
  e[type] += 1;
  report.fetched_by_year[year] = e;
}

/**
 * Orquesta `collectMissingLinks` + `fetchLinked` en el bucket MUTABLE del
 * script (mismo patrón que `downloadAll`: push in-place). Corre ANTES del
 * apply, tanto en dry-run como en `--apply` — un documento de 2025 traído por
 * enlace pasa por la MISMA regla de conocido/crear que cualquier otro.
 */
export async function followLinks(
  bucket: FollowLinksMutableBucket,
  opts: FetchLinkedOptions & { maxIterations?: number; floorDate?: string }
): Promise<FollowLinksReport> {
  const maxIterations = opts.maxIterations ?? 5;
  const seenBills = new Set(bucket.bills.map((b) => b.txn_id));
  const seenPos = new Set(bucket.purchase_orders.map((p) => p.txn_id));
  const seenReceipts = new Set(bucket.item_receipts.map((r) => r.txn_id));
  const seenCredits = bucket.vendor_credits ? new Set(bucket.vendor_credits.map((c) => c.txn_id)) : undefined;
  const report: FollowLinksReport = {
    iterations: 0,
    fetched_by_type: { bills: 0, purchase_orders: 0, item_receipts: 0, vendor_credits: 0 },
    fetched_by_year: {},
    fetched_txn_ids: { bills: [], purchase_orders: [], item_receipts: [], vendor_credits: [] },
  };

  for (let i = 0; i < maxIterations; i++) {
    const missing = collectMissingLinks(
      bucket,
      { bills: seenBills, purchase_orders: seenPos, item_receipts: seenReceipts, vendor_credits: seenCredits },
      opts.floorDate
    );
    if (missing.bills.length === 0 && missing.purchase_orders.length === 0 && missing.item_receipts.length === 0 && missing.vendor_credits.length === 0) break;
    report.iterations++;
    opts.log(
      `  followLinks iteración ${report.iterations}: bills ${missing.bills.length} · po ${missing.purchase_orders.length} · receipt ${missing.item_receipts.length} · credit ${missing.vendor_credits.length}`
    );
    // Se marcan "vistos" ANTES de fetchear — un TxnID que QB no devuelve (no
    // existe / consulta falló) no debe volver a pedirse en la próxima iteración.
    for (const id of missing.bills) seenBills.add(id);
    for (const id of missing.purchase_orders) seenPos.add(id);
    for (const id of missing.item_receipts) seenReceipts.add(id);
    for (const id of missing.vendor_credits) seenCredits?.add(id);

    const fetched = await fetchLinked(missing, opts);
    for (const b of fetched.bills) {
      bucket.bills.push(b);
      bumpYear(report, "bills", b.txn_date);
      report.fetched_by_type.bills++;
      report.fetched_txn_ids.bills.push(b.txn_id);
    }
    for (const p of fetched.purchase_orders) {
      bucket.purchase_orders.push(p);
      bumpYear(report, "purchase_orders", p.txn_date);
      report.fetched_by_type.purchase_orders++;
      report.fetched_txn_ids.purchase_orders.push(p.txn_id);
    }
    for (const r of fetched.item_receipts) {
      bucket.item_receipts.push(r);
      bumpYear(report, "item_receipts", r.txn_date);
      report.fetched_by_type.item_receipts++;
      report.fetched_txn_ids.item_receipts.push(r.txn_id);
    }
    for (const c of fetched.vendor_credits) {
      bucket.vendor_credits?.push(c);
      bumpYear(report, "vendor_credits", c.txn_date);
      report.fetched_by_type.vendor_credits++;
      report.fetched_txn_ids.vendor_credits.push(c.txn_id);
    }
  }
  return report;
}
