/**
 * QuickBooks PaymentMethod sanitizer.
 *
 * Problem: BAMS/iPOS Pays webhooks and the Dejavoo P1 terminal return card
 * brand info in free-form strings that don't match QuickBooks's PaymentMethod
 * list verbatim:
 *   - iPOS webhook: `label: "AMEX"` + `cardType: "CREDIT"`
 *   - Dejavoo SPIn: `CardType: "Visa Credit"` in ExtData
 *   - Manual POS selection: snake_case keys like "capital_one"
 * Sending an unrecognized name to QB triggers Error 3140
 * (`invalid reference to QuickBooks PaymentMethod`).
 *
 * This module is the single source of truth for:
 *   1. The canonical QB PaymentMethod names (must match QB Desktop exactly).
 *   2. The alias table that tolerates every raw variant we've seen in the wild.
 *   3. A defensive fallback: generic inputs ("credit", "card", "credit card")
 *      return `undefined` so QB leaves the field blank instead of erroring.
 *
 * Adding a new brand: update QB Desktop first (Lists → Customer & Vendor
 * Profile Lists → Payment Method List), then add it here with matching casing.
 */

/**
 * Canonical internal method key → exact QB PaymentMethod name.
 * Casing must match QB Desktop exactly (e.g. "MasterCard", not "Mastercard").
 */
export const QB_PAYMENT_METHOD_NAMES: Record<string, string> = {
  cash: "Cash",
  check: "Check",
  checking_account: "Checking Account",
  ach: "Checking Account",
  money_order: "Money Order",
  amex: "American Express",
  american_express: "American Express",
  discover: "Discover",
  mastercard: "MasterCard",
  visa: "Visa",
  credit_memo: "Credit Memo",
  paypal: "Paypal",
  return: "Return",
  transfer: "Transfer",
  wire_transfer: "Wire Transfer",
  capital_one: "Capital One",
  debit: "Debit",
  debit_card: "Debit Card",
  gift_card: "Gift Card",
  e_check: "E-Check",
  zelle: "Zelle",
};

/**
 * Pattern → canonical key. Evaluated top to bottom; first match wins.
 * Brand-specific patterns come first so "Visa Debit" maps to visa, not debit_card.
 */
const ALIAS_PATTERNS: Array<[RegExp, string]> = [
  [/capital\s*[-_]?\s*one/i, "capital_one"],
  [/american\s*express|amex/i, "amex"],
  [/master\s*card/i, "mastercard"],
  [/\bvisa\b/i, "visa"],
  [/discover/i, "discover"],
  [/gift\s*card/i, "gift_card"],
  [/\be[-_\s]?check\b|electronic\s*check|echeck/i, "e_check"],
  [/checking\s*account/i, "checking_account"],
  [/money\s*order/i, "money_order"],
  [/wire\s*transfer|\bwire\b/i, "wire_transfer"],
  [/\bach\b/i, "ach"],
  [/\bzelle\b/i, "zelle"],
  [/\bpaypal\b/i, "paypal"],
  [/credit\s*memo/i, "credit_memo"],
  // Brand-less debit (e.g. SPIn cardType="DEBIT" with no label) — match last so
  // "Visa Debit" / "MasterCard Debit" hit the brand patterns above instead.
  [/\bdebit\b/i, "debit_card"],
  [/\bcash\b/i, "cash"],
  [/\bcheck\b|\bcheque\b/i, "check"],
  [/\breturn\b/i, "return"],
  [/\btransfer\b/i, "transfer"],
];

/** Inputs that are semantically "I don't know which card, just a card". QB has no entry for these. */
const GENERIC_CARD_TOKENS = new Set([
  "card",
  "credit",
  "creditcard",
  "cc",
  "other",
  "unknown",
  "",
  // NOTE: 'credit_card' (canonical since Phase 1) is NOT in this set.
  // Callers should pass `card_brand` (visa/mastercard/...) first — if brand is
  // resolvable, it wins. If only 'credit_card' is passed with no brand, we fall
  // through to the ALIAS_PATTERNS which has no match for credit_card, so the
  // sanitizer returns undefined (same behavior as before for unknown brands).
]);

/**
 * Normalize a single raw input to our canonical internal method key.
 * Returns `undefined` for generic/unknown inputs so callers can fall back or
 * omit the PaymentMethodRef entirely.
 */
export function normalizePaymentMethodKey(
  input: string | null | undefined
): string | undefined {
  if (!input) return undefined;
  const trimmed = String(input).trim();
  if (!trimmed) return undefined;

  const normalized = trimmed.toLowerCase().replace(/\s+/g, "_");
  if (GENERIC_CARD_TOKENS.has(normalized)) return undefined;
  if (QB_PAYMENT_METHOD_NAMES[normalized]) return normalized;

  for (const [pattern, key] of ALIAS_PATTERNS) {
    if (pattern.test(trimmed)) return key;
  }
  return undefined;
}

/**
 * Resolve one or more raw brand/label/cardType strings to the exact QB
 * PaymentMethod name to send in `<PaymentMethodRef><FullName>…</FullName>`.
 *
 * Accepts multiple candidates in priority order so callers can pass
 * e.g. `(label, cardType, fallback)` and we use the first specific hit.
 * Returns `undefined` if nothing specific could be resolved — the caller
 * should omit the PaymentMethodRef rather than send a name QB will reject.
 */
export function sanitizeToQbPaymentMethod(
  ...candidates: Array<string | null | undefined>
): string | undefined {
  for (const candidate of candidates) {
    const key = normalizePaymentMethodKey(candidate);
    if (key && QB_PAYMENT_METHOD_NAMES[key]) {
      return QB_PAYMENT_METHOD_NAMES[key];
    }
  }
  return undefined;
}

/**
 * The canonical QB PaymentMethod resolver for a split `payment_method` +
 * `card_brand` pair (the schema shipped 2026-04-18 on pos_invoice and
 * customer_payment). Rule:
 *
 *   - If payment_method === 'credit_card' → send the card brand
 *     (Visa / MasterCard / American Express / Discover / Capital One).
 *     This is what the POS user sees as "Credit" + the Dejavoo-detected brand.
 *
 *   - Otherwise → send the payment_method itself
 *     (Debit Card / Cash / Check / Checking Account / Zelle / ...).
 *     Debit cards always collapse to the "Debit Card" bucket regardless of
 *     brand, so the credit-vs-debit distinction in QB accounting stays clean.
 *
 * Returns `undefined` when no specific resolution is possible (e.g.
 * credit_card with no brand recorded) — caller should omit PaymentMethodRef.
 *
 * This helper is the single source of truth for the split-aware resolution.
 * All QB payment / sales-receipt handlers MUST use it; do not inline the
 * credit_card → brand logic anywhere else.
 */
export function resolveQbPaymentMethodForPayment(
  paymentMethod: string | null | undefined,
  cardBrand: string | null | undefined
): string | undefined {
  if (paymentMethod === "credit_card") {
    return sanitizeToQbPaymentMethod(cardBrand);
  }
  return sanitizeToQbPaymentMethod(paymentMethod);
}
