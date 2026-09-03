/**
 * Order Commissions — máquina de estados (decisiones puras, sin IO).
 *
 * draft ──(pago completo Y +espera)──▶ eligible ──(aprobación)──▶ approved
 *   │                                                                │
 *   │                                              (crear check/bill)│
 *   ▼                                                                ▼
 *  void  ◀── (cancelación / refund antes de liquidar)            settling ──▶ closed
 *
 * El escritor (writer.ts) es quien persiste; acá vive únicamente la regla de
 * qué transición es legal, para que sea testeable sin base de datos.
 */

export type RecipientState = "draft" | "eligible" | "approved" | "settling" | "closed" | "void";

/**
 * Mientras TODOS los beneficiarios estén en draft o void, el modal puede
 * re-guardar. `voidRecipient` pone `state='void'` pero NO setea `deleted_at`,
 * así que los voideados siguen viniendo en `fetchCommission`; con el
 * predicado viejo (`=== "draft"`), voidear a UN beneficiario dejaba la
 * asignación imposible de re-guardar y de borrar PARA SIEMPRE (y
 * `uq_order_commission_live` impide crear otra comisión para esa orden). Un
 * beneficiario voideado es historia, no un reclamo vivo. El re-guardado los
 * soft-borra igual que a los drafts previos, así que la traza sobrevive vía
 * `deleted_at` + `void_reason` + `state='void'`.
 */
export function canReSaveAssignment(states: RecipientState[]): boolean {
  return states.every((s) => s === "draft" || s === "void");
}

/** draft→eligible es automático cuando el devengo venció. eligible→draft si dejó de valer (p.ej. refund que reabrió). */
export function refreshedState(
  current: RecipientState,
  eligibleAt: Date | null,
  now: Date
): RecipientState {
  if (current === "draft" && eligibleAt && eligibleAt.getTime() <= now.getTime()) {
    return "eligible";
  }
  if (current === "eligible" && (!eligibleAt || eligibleAt.getTime() > now.getTime())) {
    return "draft";
  }
  return current;
}

export function canApprove(current: RecipientState): boolean {
  return current === "eligible";
}

/**
 * Approve TEMPRANO (2026-09-03): la espera de waitDays todavía no venció pero
 * el devengo está DETERMINADO — pago completo + factura, o sea `eligible_at`
 * calculado aunque sea futuro. Saltea únicamente la ESPERA, nunca el pago:
 * una orden impaga o sin facturar tiene `eligible_at` null y sigue bloqueada.
 * Requiere opt-in explícito del caller (`early: true` + PIN en la ruta); la
 * traza queda sola en los datos: `approved_at < eligible_at` = fue temprano.
 */
export function canApproveEarly(
  current: RecipientState,
  eligibleAt: Date | string | null
): boolean {
  return current === "draft" && eligibleAt != null;
}

export function canStartSettlement(current: RecipientState): boolean {
  return current === "approved";
}

/** Void solo antes de que la plata salga. `settling` ya encoló documentos → no. */
export function canVoid(current: RecipientState): boolean {
  return current === "draft" || current === "eligible" || current === "approved";
}

export function isOpen(current: RecipientState): boolean {
  return current !== "closed" && current !== "void";
}
