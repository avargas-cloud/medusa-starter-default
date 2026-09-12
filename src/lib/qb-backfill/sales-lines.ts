/**
 * src/lib/qb-backfill/sales-lines.ts
 *
 * Clasificación PURA de las líneas de un documento de ventas de QB
 * (Invoice / SalesReceipt / CreditMemo) para su creación en el POS, y el
 * cuadre de totales contra el header. Sin I/O: el índice de ítems ya viene
 * cargado (`loadItemIndex`) y los faltantes se devuelven como
 * `unknown_item` para que el creador los resuelva con `ensureItem`.
 *
 * QB manda como líneas normales cosas que en el POS son campos del header:
 *   - `Subtotal`  → se descarta (es la suma de las de arriba).
 *   - `Discount…` / cualquier importe NEGATIVO sin cantidad → `discount`
 *     del header (positivo, en cents).
 *   - `SHIPPING & HANDLING` / freight / delivery → `shipping` del header.
 *   - `Sales Tax…` → se descarta; el impuesto viene de `SalesTaxTotal`.
 *   - Línea sin ítem con importe 0 (notas: "AS PER WARRANTY…") → `empty`.
 *   - Ítem de servicio sin cantidad ("Special Item", "Bank Charges") →
 *     producto con cantidad 1 y precio = importe (medido 2026-09-11 en enero).
 *
 * Total = Σ productos − descuento + envío + impuesto; tiene que igualar al
 * total del header de QB o el documento se BLOQUEA (`total_mismatch`),
 * nunca se escribe con plata que no cuadra.
 */
import { resolveItemRef, type ItemIndex, type ItemIndexEntry } from "./resolve";
import type { QbSalesLine } from "./sales-types";

export type SalesLineKind =
  | "product"
  | "unknown_item"
  | "subtotal"
  | "discount"
  | "shipping"
  | "sales_tax"
  | "empty";

export interface ClassifiedSalesLine {
  kind: SalesLineKind;
  line: QbSalesLine;
  /** Resuelto para `product`; `null` para `unknown_item` y para las no-producto. */
  item: ItemIndexEntry | null;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
}

const SUBTOTAL_RE = /^subtotal$/i;
const SALES_TAX_RE = /sales?\s*tax/i;
const SHIPPING_RE = /^(shipping|freight|delivery)/i;
const DISCOUNT_RE = /discount/i;

export function classifySalesLineForCreate(line: QbSalesLine, itemIndex: ItemIndex): ClassifiedSalesLine {
  const base = { line, item: null, quantity: 0, unit_price_cents: 0, amount_cents: line.amount_cents };
  const name = line.item_ref?.full_name ?? "";

  if (!line.item_ref) {
    if (line.amount_cents === 0) return { ...base, kind: "empty" };
    throw new Error(`línea ${line.txn_line_id}: sin ItemRef pero con importe ${line.amount_cents}`);
  }
  if (SUBTOTAL_RE.test(name)) return { ...base, kind: "subtotal" };
  if (SALES_TAX_RE.test(name)) return { ...base, kind: "sales_tax" };
  if (SHIPPING_RE.test(name)) return { ...base, kind: "shipping" };
  if (DISCOUNT_RE.test(name) || (line.amount_cents < 0 && line.quantity === null)) {
    return { ...base, kind: line.amount_cents === 0 ? "empty" : "discount" };
  }
  // Sin cantidad ni importe (notas, "Bank Charges" en 0), o cantidad 0 e importe 0 (ítem
  // anotado pero no vendido — medido en 18956): no hay venta que representar.
  if ((line.quantity === null || line.quantity === 0) && line.amount_cents === 0) return { ...base, kind: "empty" };

  const quantity = line.quantity ?? 1;
  if (!Number.isInteger(quantity)) {
    throw new Error(`línea ${line.txn_line_id} (${name}): cantidad decimal ${quantity} — el POS pide entero`);
  }
  const unitPrice =
    line.rate_cents ?? (quantity !== 0 ? Math.round(line.amount_cents / quantity) : line.amount_cents);
  const item = resolveItemRef(itemIndex, line.item_ref);
  return { ...base, kind: item ? "product" : "unknown_item", item, quantity, unit_price_cents: unitPrice };
}

export interface SalesTotals {
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
}

export function computeSalesTotals(classified: readonly ClassifiedSalesLine[], taxCents: number): SalesTotals {
  const sum = (kind: SalesLineKind) =>
    classified.filter((c) => c.kind === kind).reduce((s, c) => s + c.amount_cents, 0);
  const subtotal = sum("product") + sum("unknown_item");
  const discount = -sum("discount");
  const shipping = sum("shipping");
  return {
    subtotal_cents: subtotal,
    discount_cents: discount,
    shipping_cents: shipping,
    tax_cents: taxCents,
    total_cents: subtotal - discount + shipping + taxCents,
  };
}

export type SalesLinePlan =
  | { ok: true; lines: ClassifiedSalesLine[]; totals: SalesTotals }
  | { ok: false; reason: "total_mismatch"; computed_cents: number; expected_cents: number; totals: SalesTotals }
  | { ok: false; reason: "line_error"; detail: string };

/** Clasifica todas las líneas y cuadra contra el total del header. No escribe nada. */
export function planSalesLines(
  lines: readonly QbSalesLine[],
  itemIndex: ItemIndex,
  taxCents: number,
  expectedTotalCents: number
): SalesLinePlan {
  let classified: ClassifiedSalesLine[];
  try {
    classified = lines.map((l) => classifySalesLineForCreate(l, itemIndex));
  } catch (err) {
    return { ok: false, reason: "line_error", detail: (err as Error).message };
  }
  const totals = computeSalesTotals(classified, taxCents);
  if (totals.total_cents !== expectedTotalCents) {
    return {
      ok: false,
      reason: "total_mismatch",
      computed_cents: totals.total_cents,
      expected_cents: expectedTotalCents,
      totals,
    };
  }
  return { ok: true, lines: classified, totals };
}

/** Las líneas que se vuelven ítems del documento del POS (producto resuelto o a crear). */
export function productLines(plan: readonly ClassifiedSalesLine[]): ClassifiedSalesLine[] {
  return plan.filter((c) => c.kind === "product" || c.kind === "unknown_item");
}
