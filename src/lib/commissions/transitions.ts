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

/** Mientras TODOS los beneficiarios estén en draft, el modal puede re-guardar. */
export function canReSaveAssignment(states: RecipientState[]): boolean {
  return states.every((s) => s === "draft");
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
