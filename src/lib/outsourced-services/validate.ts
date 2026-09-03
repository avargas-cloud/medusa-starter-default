/**
 * Order Outsourced Services — validación de entrada. Puro, sin IO.
 *
 * No hay "calculator" como en comisiones porque no hay nada que calcular: el
 * monto es la cifra que el subcontratista cotizó, no una participación en la
 * venta. Esa fue una decisión, no una omisión — atar el costo al subtotal de la
 * orden haría que editar la venta mueva en silencio una obligación con un
 * tercero, y abre preguntas sin respuesta buena (¿antes o después del descuento?
 * ¿incluye flete? ¿se recalcula si ya se aprobó?).
 */

export interface ServiceInput {
  qbVendorId: string;
  vendorDisplayName: string;
  serviceTypeId: string;
  amountCents: number;
  description?: string | null;
  vendorInvoiceNumber?: string | null;
}

export type ValidationFailure =
  | "missing_vendor"
  | "missing_vendor_name"
  | "missing_service_type"
  | "invalid_amount"
  | "amount_too_large"
  | "description_too_long";

/**
 * Techo defensivo. No es una regla de negocio (no hay cap): es la diferencia
 * entre un typo de tecla y una cifra plausible. $1.000.000 en un subcontrato de
 * iluminación es un dedo de más, y un monto se congela al aprobar.
 */
export const MAX_SERVICE_AMOUNT_CENTS = 100_000_000;
export const MAX_DESCRIPTION_LENGTH = 500;

export function validateService(
  input: ServiceInput
): { ok: true } | { ok: false; reason: ValidationFailure } {
  if (!input.qbVendorId?.trim()) return { ok: false, reason: "missing_vendor" };
  if (!input.vendorDisplayName?.trim()) {
    return { ok: false, reason: "missing_vendor_name" };
  }
  if (!input.serviceTypeId?.trim()) {
    return { ok: false, reason: "missing_service_type" };
  }
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0
  ) {
    return { ok: false, reason: "invalid_amount" };
  }
  if (input.amountCents > MAX_SERVICE_AMOUNT_CENTS) {
    return { ok: false, reason: "amount_too_large" };
  }
  if ((input.description?.length ?? 0) > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, reason: "description_too_long" };
  }
  return { ok: true };
}

/** Mensajes para el operador. El código viaja aparte para que la UI ramifique. */
export const VALIDATION_MESSAGE: Record<ValidationFailure, string> = {
  missing_vendor: "Pick the vendor that performed the service.",
  missing_vendor_name: "The vendor is missing a display name.",
  missing_service_type: "Pick a service type.",
  invalid_amount: "Enter an amount greater than zero.",
  amount_too_large: "That amount looks like a typo — it exceeds the allowed maximum.",
  description_too_long: `Keep the description under ${MAX_DESCRIPTION_LENGTH} characters.`,
};

/**
 * Duplicado PROBABLE: mismo vendor, mismo tipo, mismo monto, misma orden.
 * Deliberadamente NO es un constraint de base — dos visitas del mismo instalador
 * a la misma obra son legítimas. Es una advertencia que la UI muestra y el
 * operador confirma, no un rechazo.
 */
export function looksLikeDuplicate(
  candidate: Pick<ServiceInput, "qbVendorId" | "serviceTypeId" | "amountCents">,
  existing: ReadonlyArray<
    Pick<ServiceInput, "qbVendorId" | "serviceTypeId" | "amountCents">
  >
): boolean {
  return existing.some(
    (e) =>
      e.qbVendorId === candidate.qbVendorId &&
      e.serviceTypeId === candidate.serviceTypeId &&
      e.amountCents === candidate.amountCents
  );
}
