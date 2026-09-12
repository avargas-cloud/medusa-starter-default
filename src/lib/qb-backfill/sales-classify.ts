/**
 * src/lib/qb-backfill/sales-classify.ts
 *
 * Clasificación PURA (sin IO) del bucket de ventas descargado contra lo que
 * el POS ya conoce (`sales-resolve.ts::loadKnownSalesTxnIds`). Mismo rol que
 * `decidePoCreation` (`create-po.ts`) pero para los 4 tipos a la vez, porque
 * las reglas de bloqueo son transversales (POS-origin, ventana cerrada).
 *
 * Razones de bloqueo (nombre del check = valor de `reason`, para que el
 * reporte y el código señalen exactamente lo mismo):
 *
 *   - `after_clone_pos_memo` — el documento lo creó el POS y el enlace sólo
 *     está ausente (no hace falta re-crear NADA): `txn_date` posterior al
 *     `--to` del run (guard de rango), o `memo` matchea
 *     `/^Medusa (Invoice|SR|Order)/`, o `ref_number` tiene forma de número
 *     POS (`^(INV-)?2[0-9]{4}$`) Y el documento es de 2026-04-14 en
 *     adelante (antes de esa fecha el POS no numeraba así).
 *   - `voided_zero_total` — SÓLO invoice/SR: total en 0, TODAS sus líneas
 *     en 0 y memo `VOID:` → documento voideado en QB, nada que backfillear.
 *     Un $0 sin ese memo (garantía, cortesía) es un documento real y se crea.
 *   - `sales_receipt_2025` — SÓLO sales receipt: nace pagado, así que un SR
 *     de 2025 NUNCA se sigue por enlace ni se trae — si aparece en el
 *     bucket (no debería) se bloquea igual, por las dudas.
 *   - `closed_2025` — SÓLO invoice: fecha 2025, no vino por
 *     `sales-follow-links.ts` (`via_link`) y no está en el set de impagos
 *     hoy (`--unpaid-2025`) → estaba cerrado antes del piso, fuera de
 *     alcance por diseño (igual que un PO/bill "closed_2025" del lado
 *     compras).
 *
 * `known_txn_id` no es una razón de bloqueo — es el conteo `already`: el
 * documento YA tiene su TxnID enlazado a una fila del POS, no hay nada que
 * crear ni que reportar como bloqueado.
 */
import type { QbCreditMemo, QbInvoice, QbReceivePayment, QbSalesReceipt } from "./sales-types";
import type { KnownSalesTxnIds } from "./sales-resolve";

export interface ClassifyBucketResult<T> {
  already: number;
  create: T[];
  blocked: { txn_id: string; reason: string }[];
}

export interface SalesClassification {
  invoices: ClassifyBucketResult<QbInvoice>;
  sales_receipts: ClassifyBucketResult<QbSalesReceipt>;
  payments: ClassifyBucketResult<QbReceivePayment>;
  credit_memos: ClassifyBucketResult<QbCreditMemo>;
}

export interface ClassifySalesOptions {
  /** `--to` del run — guard de rango: un `txn_date` posterior es un documento clonado por el POS. */
  toDate: string;
  /** `bucket.unpaid_invoices_2025` (`--unpaid-2025`) — invoices de 2025 abiertos hoy, exentos de `closed_2025`. */
  unpaidInvoiceTxnIds: ReadonlySet<string>;
  /** Piso de "2025" — default `2026-01-01`. */
  floorDate?: string;
}

const POS_ORIGIN_MEMO_RE = /^Medusa (Invoice|SR|Order)/;
const POS_ORIGIN_REF_RE = /^(INV-)?2[0-9]{4}$/;
const POS_ORIGIN_REF_FLOOR = "2026-04-14";

function isPosOrigin(txnDate: string, memo: string | null, refNumber: string | null, toDate: string): boolean {
  if (txnDate > toDate) return true;
  if (memo && POS_ORIGIN_MEMO_RE.test(memo)) return true;
  if (refNumber && POS_ORIGIN_REF_RE.test(refNumber) && txnDate >= POS_ORIGIN_REF_FLOOR) return true;
  return false;
}

/**
 * Voideado en QB = total 0, todas las líneas en 0 Y memo `VOID:` (QB antepone
 * "VOID:" al memo al voidear). Medido en la caché ene–abr 2026: de 113
 * invoices con subtotal 0, 83 llevan el memo VOID y 30 son documentos
 * legítimos de $0 (reemplazos por garantía, cortesías) que SÍ se crean.
 */
function isVoidedZeroTotal(
  totalCents: number,
  lines: readonly { amount_cents: number }[],
  memo: string | null | undefined
): boolean {
  return totalCents === 0 && lines.every((l) => l.amount_cents === 0) && /^\s*void\b/i.test(memo ?? "");
}

function classifyOne<T extends { txn_id: string }>(
  doc: T,
  known: ReadonlySet<string>,
  blockedReason: (doc: T) => string | null,
  already: { n: number },
  create: T[],
  blocked: { txn_id: string; reason: string }[]
): void {
  if (known.has(doc.txn_id)) {
    already.n++;
    return;
  }
  const reason = blockedReason(doc);
  if (reason) {
    blocked.push({ txn_id: doc.txn_id, reason });
    return;
  }
  create.push(doc);
}

export function classifySalesBucket(
  bucket: { invoices: readonly QbInvoice[]; sales_receipts: readonly QbSalesReceipt[]; payments: readonly QbReceivePayment[]; credit_memos: readonly QbCreditMemo[] },
  known: KnownSalesTxnIds,
  opts: ClassifySalesOptions
): SalesClassification {
  const floorDate = opts.floorDate ?? "2026-01-01";

  const invoices: ClassifyBucketResult<QbInvoice> = { already: 0, create: [], blocked: [] };
  const invAlready = { n: 0 };
  for (const doc of bucket.invoices) {
    classifyOne(
      doc,
      known.invoices,
      (d) => {
        if (isPosOrigin(d.txn_date, d.memo, d.ref_number, opts.toDate)) return "after_clone_pos_memo";
        if (isVoidedZeroTotal(d.subtotal_cents + d.sales_tax_total_cents, d.lines, d.memo)) return "voided_zero_total";
        if (d.txn_date < floorDate && !d.via_link && !opts.unpaidInvoiceTxnIds.has(d.txn_id)) return "closed_2025";
        return null;
      },
      invAlready,
      invoices.create,
      invoices.blocked
    );
  }
  invoices.already = invAlready.n;

  const sales_receipts: ClassifyBucketResult<QbSalesReceipt> = { already: 0, create: [], blocked: [] };
  const srAlready = { n: 0 };
  for (const doc of bucket.sales_receipts) {
    classifyOne(
      doc,
      known.sales_receipts,
      (d) => {
        if (d.txn_date < floorDate) return "sales_receipt_2025";
        if (isPosOrigin(d.txn_date, d.memo, d.ref_number, opts.toDate)) return "after_clone_pos_memo";
        if (isVoidedZeroTotal(d.total_amount_cents, d.lines, d.memo)) return "voided_zero_total";
        return null;
      },
      srAlready,
      sales_receipts.create,
      sales_receipts.blocked
    );
  }
  sales_receipts.already = srAlready.n;

  const payments: ClassifyBucketResult<QbReceivePayment> = { already: 0, create: [], blocked: [] };
  const payAlready = { n: 0 };
  for (const doc of bucket.payments) {
    classifyOne(
      doc,
      known.payments,
      (d) => (isPosOrigin(d.txn_date, d.memo, d.ref_number, opts.toDate) ? "after_clone_pos_memo" : null),
      payAlready,
      payments.create,
      payments.blocked
    );
  }
  payments.already = payAlready.n;

  const credit_memos: ClassifyBucketResult<QbCreditMemo> = { already: 0, create: [], blocked: [] };
  const cmAlready = { n: 0 };
  for (const doc of bucket.credit_memos) {
    classifyOne(
      doc,
      known.credit_memos,
      (d) => (isPosOrigin(d.txn_date, d.memo, d.ref_number, opts.toDate) ? "after_clone_pos_memo" : null),
      cmAlready,
      credit_memos.create,
      credit_memos.blocked
    );
  }
  credit_memos.already = cmAlready.n;

  return { invoices, sales_receipts, payments, credit_memos };
}
