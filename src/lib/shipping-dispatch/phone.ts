/**
 * src/lib/shipping-dispatch/phone.ts
 *
 * UPS rejects the ENTIRE quote/shipment when a US phone has <10 digits (real
 * POS data has short/legacy phones). Phone is optional for rating and for US
 * domestic shipping — omit it when it can't pass carrier validation instead
 * of losing the whole operation. Shared by the Shippo and UPS-direct adapters.
 */

export function sanitizePhone(
  phone: string | undefined,
  country: string
): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, "");
  if (country.toUpperCase() === "US") {
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits.startsWith("1")) return digits;
    return undefined;
  }
  return digits.length >= 7 ? digits : undefined;
}
