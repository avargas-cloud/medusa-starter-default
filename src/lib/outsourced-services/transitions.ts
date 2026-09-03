/**
 * Order Outsourced Services — máquina de estados. Puro, sin IO.
 *
 *   draft ──approve(PIN)──▶ approved ──settle(PIN)──▶ settling ──QB──▶ posted
 *     │                        │                          │
 *     └────────void(PIN)───────┴──────────────────────────┘
 *
 * Diferencias deliberadas con comisiones:
 *
 * - NO existe `eligible`. Comisiones lo tiene porque su devengo depende del pago
 *   de la orden y de una espera; el costo de un subcontrato se debe cuando el
 *   trabajo se hizo, no cuando el cliente paga. Sin devengo no hay refresh-on-read.
 *
 * - El terminal se llama `posted`, no `closed`. Lo que dispara la transición es
 *   `vendor_bill.qb_txn_id`, que prueba que el bill se ASENTÓ en QuickBooks —
 *   no que el subcontratista haya cobrado. Llamarlo "closed"/"paid" haría que la
 *   pantalla afirme un hecho que el sistema no observó.
 *
 * - Desde `settling` NO se puede voidear: hay un bill vivo reclamado. Primero se
 *   resuelve el bill (falla o reversa el settlement) y recién ahí se libera.
 */

export type ServiceState =
  | "draft"
  | "approved"
  | "settling"
  | "posted"
  | "void";

export const SERVICE_STATES: readonly ServiceState[] = [
  "draft",
  "approved",
  "settling",
  "posted",
  "void",
] as const;

export function isServiceState(value: string): value is ServiceState {
  return (SERVICE_STATES as readonly string[]).includes(value);
}

/**
 * Editar o borrar un servicio sólo mientras sea borrador. Una vez aprobado la
 * obligación está congelada: el cambio material es void + alta nueva, que deja
 * las dos filas en la traza en vez de reescribir la historia.
 */
export function canEdit(state: ServiceState): boolean {
  return state === "draft";
}

/** Aprobar congela monto, vendor, tipo y cuenta, y reclama el OSV-####. */
export function canApprove(state: ServiceState): boolean {
  return state === "draft";
}

/** Liquidar exige un servicio aprobado — nunca un borrador. */
export function canStartSettlement(state: ServiceState): boolean {
  return state === "approved";
}

/**
 * Void permitido en draft y approved. NO en settling (hay un bill reclamado) ni
 * en posted (el asiento ya existe en QuickBooks: corresponde un vendor credit,
 * no borrar el registro de que la plata se debió).
 */
export function canVoid(state: ServiceState): boolean {
  return state === "draft" || state === "approved";
}

/** "Abierto" = todavía requiere trabajo del operador. Alimenta el tab del listado. */
export function isOpen(state: ServiceState): boolean {
  return state !== "posted" && state !== "void";
}
