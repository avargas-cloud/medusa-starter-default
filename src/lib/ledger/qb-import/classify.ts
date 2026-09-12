/**
 * qb-gl-import — regla de NO doble conteo (docs/QB_GL_IMPORT.md §2). Pura.
 *
 * El libro tiene dos fuentes que NO se pisan:
 * - El POS postea sus propios documentos desde `GL_REPLAY_FROM` (2026-04-14,
 *   `jobs/ledger-reconciler.ts`): invoices, credit memos, cobros, bills,
 *   vendor credits, recepciones y pagos de bills. De QB, esos tipos entran
 *   SÓLO hasta `POS_CUTOFF_DAY` (el día anterior al replay).
 * - Los tipos que el POS no produce (cheques, depósitos, tarjetas, asientos,
 *   transferencias, nómina, ajustes de inventario, pagos de sales tax) entran
 *   de QB en TODO el rango pedido.
 *
 * Un tipo que no está en ninguna tabla se BLOQUEA: nunca se adivina de qué
 * lado cae un documento que el diseño no nombró.
 */
import type { ClassifyDecision, ImportPolicy } from "./types";

/** Último día que entra desde QB para los tipos que el POS postea. */
export const POS_CUTOFF_DAY = "2026-04-13";

/** `TxnType` del reporte → tipo que el POS produce desde el replay. */
export const POS_OWNED_TYPES: ReadonlySet<string> = new Set([
  "Invoice",
  "Sales Receipt",
  "Credit Memo",
  "Payment", // cobro de cliente → customer_payment
  "Discount", // descuento aplicado al cobrar → parte del cobro en el POS
  "Credit Card Refund", // refund al cliente (ARRefundCreditCard) → refund terminal del POS (customer_payment)
  "Bill",
  "Credit", // vendor credit (QB lo imprime "Credit")
  "Item Receipt",
  "Bill Pmt -Check",
  "Bill Pmt -CCard",
]);

/** `TxnType` del reporte → tipo que el POS NO produce: entra siempre desde QB. */
export const BANK_SIDE_TYPES: ReadonlySet<string> = new Set([
  "Check",
  "Deposit",
  "Credit Card Charge",
  "Credit Card Credit",
  "General Journal",
  "Transfer",
  "Inventory Adjust",
  "Inventory Transfer", // traslado entre sitios (QB Enterprise); el POS no lo postea al libro (1 en ene–abr 2026)
  "Sales Tax Payment",
  "Paycheck",
  "Liability Check",
  "Payroll Liability Check",
  "Liability Adjustment",
  "YTD Adjustment",
]);

export function policyFor(txnType: string): ImportPolicy | null {
  if (POS_OWNED_TYPES.has(txnType)) return "pos_owned";
  if (BANK_SIDE_TYPES.has(txnType)) return "bank_side";
  return null;
}

/**
 * Decide qué hacer con un documento de QB dado su tipo, su fecha (YYYY-MM-DD)
 * y si el POS lo CONOCE (`pos-links.ts`: su TxnID está enlazado a un documento
 * del POS que el libro postea).
 *
 * Después del corte manda la IDENTIDAD, no el tipo: si el POS lo sincronizó se
 * omite (lo postea el replay) — vale también para un "tipo bancario" como el
 * cheque de un refund; si no está enlazado entra desde QB (`qb_only` cuando es
 * un tipo que el POS normalmente produce). Un tipo del POS sin dato de enlace
 * (`knownToPos` undefined) se omite: no contar dos veces vale más que importar
 * de más. Antes del corte entra todo (el replay arranca 2026-04-14).
 */
export function classify(
  txnType: string,
  date: string,
  cutoffDay: string = POS_CUTOFF_DAY,
  knownToPos?: boolean
): ClassifyDecision {
  const policy = policyFor(txnType);
  if (!policy) return { action: "blocked_unknown_type" };
  if (date > cutoffDay) {
    if (knownToPos === true) return { action: "skip_pos_owned_after_cutoff", policy };
    if (policy === "pos_owned") {
      if (knownToPos === false) return { action: "import", policy, qb_only: true };
      return { action: "skip_pos_owned_after_cutoff", policy };
    }
  }
  return { action: "import", policy };
}
