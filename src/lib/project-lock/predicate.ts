import type { LockReason, OrderSettlementFacts } from "./types";

/**
 * El predicado del candado, puro. Es el MISMO que bloquea el sync del BOM en
 * el POS (`store-pos/lib/project-bom-sync.ts` → `orderSyncBlockReason`):
 *
 *   entregó unidades            → 'fulfilled'
 *   recibió ≥ 1 centavo         → 'paid'
 *   si no                       → null (no se lockea)
 *
 * "Recibió" = MAX(received_cents de la proyección, capturado nativo). La
 * proyección (`order_money_projection`, aplicado + depósito) es la verdad del
 * POS; el capturado nativo cubre una orden de la web pagada con tarjeta antes
 * de que la proyección se recompute. Se toma el mayor, nunca la suma: son dos
 * lecturas del mismo dinero (mismo criterio que `maybe-complete-order`).
 *
 * Un estimate (draft order) o una orden borrada nunca lockea: el vínculo
 * existe, el dinero no.
 */
export function receivedCentsOf(facts: OrderSettlementFacts): number {
  return Math.max(facts.projectionReceivedCents, facts.capturedCents);
}

export function lockReasonFromFacts(facts: OrderSettlementFacts): LockReason | null {
  if (!facts.exists || facts.deleted || facts.isDraftOrder) return null;
  if (facts.fulfilledUnits > 0) return "fulfilled";
  if (receivedCentsOf(facts) >= 1) return "paid";
  return null;
}
