import { signedLine } from "../money";
import { LedgerLine, PurchaseAccountMap } from "../types";

export interface ReceiptLineSnapshot {
  qtyReceivedNow: number;
  /** `unit_cost_cents_override ?? po_line.unit_cost_cents` — ya resuelto por el loader. */
  unitCostCents: bigint;
}

export interface ReceiptSnapshot {
  lines: ReceiptLineSnapshot[];
}

/**
 * gl-purchases-v2 §2: un receipt sólo mueve cantidad — el costo es el que
 * ya tenía el PO (o su override de esta línea de recepción). Débito
 * `inventory_asset`, crédito `inventory_offset` (cuenta puente que la
 * confirmación del bill regular cancela por el mismo monto vía `offsetCents`
 * en `buildVendorBillLines`). Total 0 (cantidades/costos en cero) → sin
 * líneas, el loader lo trata como `skipped`.
 */
export function buildReceiptLines(
  snapshot: ReceiptSnapshot,
  map: PurchaseAccountMap
): LedgerLine[] {
  const total = snapshot.lines.reduce(
    (sum, l) => sum + BigInt(Math.trunc(l.qtyReceivedNow)) * l.unitCostCents,
    0n
  );
  const debit = signedLine("inventory_asset", map.inventory_asset, total);
  const credit = signedLine("inventory_offset", map.inventory_offset, -total);
  const lines: LedgerLine[] = [];
  if (debit) lines.push(debit);
  if (credit) lines.push(credit);
  return lines;
}
