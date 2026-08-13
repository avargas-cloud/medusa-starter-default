/**
 * Asignación por línea del descuento de ORDEN — función PURA.
 *
 * Única fórmula del sistema (plan descuentos-canonicos-v1): la consumen el
 * facade transaccional (`apply-order-discount.ts`) y el comparador read-only.
 * Espeja la matemática del POS (`store-pos/lib/pos-totals.ts` computeTotals):
 *
 * - percent: `round(lineNet × rate)` POR LÍNEA; el total del descuento ES la
 *   suma de los redondeos (nunca se redondea el agregado — convención Medusa
 *   que el POS adoptó, ver project_order_total_single_derivation).
 * - fixed: el total es exacto (`round(value × 100)` cents) y se distribuye
 *   proporcional al neto de CADA línea (taxable y no-taxable por igual, así
 *   la proporción taxable se conserva y el tax coincide con el POS), con el
 *   residuo asignado determinísticamente por mayor resto fraccional
 *   (desempate: índice de línea) para que la suma cierre EXACTA.
 *
 * El neto de línea llega ya post-descuento-de-línea: en este sistema los
 * descuentos por ítem van horneados en `unit_price`, nunca como adjustment.
 */

export interface AllocationLine {
  /** order_line_item id — la clave del adjustment resultante. */
  itemId: string;
  /** Neto de la línea en CENTS (unit_price × quantity, post line-discount). */
  netCents: number;
  taxable: boolean;
}

export type DiscountIntent =
  | { type: "percent"; value: number }
  | { type: "fixed"; value: number };

export interface LineAllocation {
  itemId: string;
  /** Descuento asignado a esta línea, en CENTS (≥ 0). */
  adjustmentCents: number;
  taxable: boolean;
}

export interface AllocationResult {
  lines: LineAllocation[];
  /** Suma exacta de los adjustments (cents). */
  totalCents: number;
}

export function allocateOrderDiscount(
  lines: AllocationLine[],
  intent: DiscountIntent
): AllocationResult {
  for (const l of lines) {
    if (!Number.isFinite(l.netCents) || l.netCents < 0) {
      // refuse-no-guess: una línea ilegible NO vale 0 — tira, igual que la
      // derivación canónica de totales.
      throw new Error(
        `allocateOrderDiscount: línea ${l.itemId} con netCents ilegible (${l.netCents})`
      );
    }
  }
  if (!Number.isFinite(intent.value) || intent.value < 0) {
    throw new Error(
      `allocateOrderDiscount: intent.value ilegible (${intent.value})`
    );
  }

  if (intent.type === "percent") {
    const rate = intent.value / 100;
    const allocated = lines.map((l) => ({
      itemId: l.itemId,
      adjustmentCents: Math.min(l.netCents, Math.round(l.netCents * rate)),
      taxable: l.taxable,
    }));
    return {
      lines: allocated,
      totalCents: allocated.reduce((s, a) => s + a.adjustmentCents, 0),
    };
  }

  // fixed
  const targetCents = Math.round(intent.value * 100);
  const baseCents = lines.reduce((s, l) => s + l.netCents, 0);
  if (baseCents <= 0 || targetCents <= 0) {
    return {
      lines: lines.map((l) => ({
        itemId: l.itemId,
        adjustmentCents: 0,
        taxable: l.taxable,
      })),
      totalCents: 0,
    };
  }
  // El descuento no puede exceder la base (un fixed mayor deja las líneas en 0).
  const effectiveTarget = Math.min(targetCents, baseCents);

  const raw = lines.map((l, idx) => {
    const exact = (l.netCents / baseCents) * effectiveTarget;
    const floor = Math.floor(exact);
    return { idx, itemId: l.itemId, taxable: l.taxable, floor, frac: exact - floor, cap: l.netCents };
  });
  let assigned = raw.reduce((s, r) => s + Math.min(r.floor, r.cap), 0);
  const alloc = raw.map((r) => Math.min(r.floor, r.cap));

  // Residuo por mayor resto fraccional; desempate por índice (determinista).
  const order = [...raw].sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  let remaining = effectiveTarget - assigned;
  let cursor = 0;
  while (remaining > 0) {
    const r = order[cursor % order.length]!;
    if (alloc[r.idx]! < r.cap) {
      alloc[r.idx] = alloc[r.idx]! + 1;
      remaining--;
    }
    cursor++;
    if (cursor > order.length * (effectiveTarget + 1)) {
      // Salvavidas: jamás loopear infinito (todas las líneas al tope).
      break;
    }
  }
  void assigned;

  const allocated = lines.map((l, idx) => ({
    itemId: l.itemId,
    adjustmentCents: alloc[idx]!,
    taxable: l.taxable,
  }));
  return {
    lines: allocated,
    totalCents: allocated.reduce((s, a) => s + a.adjustmentCents, 0),
  };
}
