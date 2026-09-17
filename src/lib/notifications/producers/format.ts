/** Formato compartido de los productores: dinero y etiquetas cortas. */

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Centavos (numeric/string de pg) → "$1,234.56". Coerciona SIEMPRE antes de operar. */
export function centsToUsd(raw: unknown): string {
  const n = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? "0"));
  return USD.format((Number.isFinite(n) ? n : 0) / 100);
}

const METHOD_LABELS: Record<string, string> = {
  credit_card: "Credit card",
  debit_card: "Debit card",
  card: "Card",
  cash: "Cash",
  check: "Check",
  zelle: "Zelle",
  ach: "ACH",
  other: "Other",
};

export function methodLabel(method: string | null | undefined): string {
  if (!method) return "Payment";
  return METHOD_LABELS[method] ?? method.replace(/_/g, " ");
}

export function truncate(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Nombre mostrable de un cliente: empresa, si no nombre, si no email. */
export function customerLabel(row: {
  company_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}): string {
  const company = (row.company_name ?? "").trim();
  if (company) return company;
  const person = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
  if (person) return person;
  return (row.email ?? "").trim() || "Customer";
}
