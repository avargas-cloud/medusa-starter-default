/**
 * qb-ref-number.ts
 *
 * QuickBooks Desktop caps `<RefNumber>` at 11 characters and rejects the whole
 * request past it — error 3070, *"the string … in the field RefNumber is too
 * long"*. The request never reaches the document, so nothing partial is
 * created; it simply fails.
 *
 * WHY THIS EXISTS (2026-08-04)
 * ---------------------------
 * An item receipt's RefNumber is the operator's packing-slip field. Someone
 * typed "Correct Quantity Received" (25 chars) as the reference, and the
 * receipt could not reach QuickBooks at all — with the failure surfacing much
 * later as a red pipeline row, far from the screen where the text was typed.
 *
 * The cut happens AT THE BOUNDARY, never on the stored value. Same discipline
 * as the NBSP sanitiser: the POS keeps whatever the operator wrote, and only
 * what travels to QuickBooks is adjusted. Truncating the record itself would
 * quietly destroy a reference the vendor may actually use.
 */

/** QuickBooks Desktop's hard limit for the RefNumber field. */
export const QB_REF_NUMBER_MAX_LENGTH = 11;

/**
 * Returns `value` trimmed to what QuickBooks will accept, or null when there is
 * nothing to send.
 *
 * Truncation is deliberately dumb — first 11 characters. A reference number is
 * usually prefixed ("V260717-I1", "PS-0042"), so the front carries the
 * identifying part; anything cleverer would guess at meaning it cannot know.
 */
export function toQbRefNumber(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, QB_REF_NUMBER_MAX_LENGTH);
}

/** True when sending `value` as a RefNumber would lose characters. */
export function refNumberWouldTruncate(
  value: string | null | undefined
): boolean {
  return (value?.trim().length ?? 0) > QB_REF_NUMBER_MAX_LENGTH;
}
