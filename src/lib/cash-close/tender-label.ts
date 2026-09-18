/**
 * Tender labels for Cash Close — replicated from `store-pos/lib/payments.ts`
 * (`METHOD_LABELS`) and `store-pos/lib/bank-deposits.ts` (`CARD_METHODS`,
 * `CARD_BRAND_LABELS`, `receiptMethodLabel`), and `getPaymentSource` from
 * `store-pos/app/(pos)/payments/page.tsx:229`.
 *
 * There is no shared package between backend and store-pos, so this is a
 * deliberate copy, not an import — the backend has no visibility into the
 * frontend's source tree at build time. Any label change on the POS side
 * needs the mirror updated here too.
 */

export const METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  check: "Check",
  card: "Card",
  ach: "ACH / Bank Transfer",
  zelle: "Zelle",
  credit_memo: "Store Credit",
  stripe: "Stripe",
  other: "Other",
  credit_card: "Credit Card",
  debit_card: "Debit Card",
  credit: "Store Credit",
  card_refund: "Card refund",
};

const CARD_METHODS = new Set(["credit_card", "debit_card", "card"]);

const CARD_BRAND_LABELS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  discover: "Discover",
};

function titleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** "Visa · Credit Card" for a card receipt with a known brand; the plain
 * METHOD_LABELS entry otherwise. */
export function receiptMethodLabel(
  method: string,
  cardBrand?: string | null
): string {
  const label = METHOD_LABELS[method] ?? titleCase(method);
  if (CARD_METHODS.has(method) && cardBrand) {
    const brand = CARD_BRAND_LABELS[cardBrand.toLowerCase()] ?? titleCase(cardBrand);
    return `${brand} · ${label}`;
  }
  return label;
}

/** Group key for the tender rows: `${method}|${card_brand ?? ''}`. */
export function tenderKey(method: string, cardBrand?: string | null): string {
  return `${method}|${cardBrand ?? ""}`;
}

/**
 * "Terminal" | "Online" | "Cash Drawer" | … — copy of `getPaymentSource` in
 * `store-pos/app/(pos)/payments/page.tsx:229`.
 */
export function getPaymentSource(
  metadata: Record<string, unknown> | null | undefined,
  method: string
): string {
  const txnType = metadata?.transaction_type as string | undefined;
  if (txnType === "terminal_payment") return "Terminal";
  if (txnType === "bams_online_payment") return "Online";
  switch (method) {
    case "cash":
      return "Cash Drawer";
    case "check":
      return "Check";
    case "ach":
    case "zelle":
      return "Bank Transfer";
    case "stripe":
      return "Stripe (Online)";
    case "credit_memo":
      return "Credit Memo";
    default:
      return "Manual";
  }
}
