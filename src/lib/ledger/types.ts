/**
 * gl-core-v1 §5 — tipos públicos del motor. Nada acá toca la DB; los
 * documentos concretos (`documents/*.ts`) cargan snapshots y llaman al motor.
 */

export type LedgerSourceKind =
  | "pos_invoice"
  | "pos_credit_memo"
  | "customer_payment"
  | "rounding_adjustment"
  | "po_receipt"
  | "vendor_bill"
  | "vendor_credit"
  | "vendor_bill_payment"
  | "opening_balance";

export interface LedgerAccount {
  id: string;
  name: string;
  account_type: string;
  currency: "USD";
  normal_balance: "debit" | "credit" | null;
}

export interface LedgerLine {
  role: string;
  account: LedgerAccount;
  debit_cents: bigint;
  credit_cents: bigint;
  memo?: string;
}

export interface LedgerClaim {
  source_kind: "payment_recognition";
  source_id: string;
  amount_cents: bigint;
  capacity_cents: bigint;
  source_hash: string;
}

export interface PostDocumentInput {
  source_kind: LedgerSourceKind;
  source_id: string;
  document_number: string;
  /** YYYY-MM-DD en ET (etMidnightUtc / getBusinessDateString). */
  day: string;
  reference: string;
  description: string;
  lines: LedgerLine[];
  source_snapshot: Record<string, unknown>;
  source_hash: string;
  actor_id: string;
  claims?: LedgerClaim[];
}

export type PostResult =
  | { status: "posted"; entry_id: string }
  | { status: "already_posted"; entry_id: string }
  | { status: "skipped"; reason: string };

export type ReverseResult =
  | { status: "reversed"; entry_id: string }
  | { status: "nothing_to_reverse" }
  | { status: "already_reversed"; entry_id: string };

export type LedgerErrorCode =
  | "GL_ACCOUNT_MAP_MISSING"
  | "GL_UNBALANCED_DOCUMENT"
  | "GL_PERIOD_CLOSED"
  | "GL_SOURCE_INVALID"
  | "GL_ALREADY_POSTED";

export class LedgerError extends Error {
  code: LedgerErrorCode;
  details?: unknown;
  constructor(code: LedgerErrorCode, details?: unknown) {
    super(code);
    this.name = "LedgerError";
    this.code = code;
    this.details = details;
  }
}

/** Claves de `gl_account_map` — §3 (las 9 históricas). */
export const ACCOUNT_MAP_KEYS = [
  "accounts_receivable",
  "undeposited_funds",
  "sales_tax_payable",
  "inventory_asset",
  "sales_discounts",
  "shipping_income",
  "income_default",
  "cogs_default",
  "bad_debt",
] as const;
export type AccountMapKey = (typeof ACCOUNT_MAP_KEYS)[number];
export type AccountMap = Record<AccountMapKey, LedgerAccount>;

/**
 * gl-purchases-v2 §2/§3 — keys nuevos, deliberadamente NO agregados a
 * `ACCOUNT_MAP_KEYS`: ese array es lo que `loadAccountMap` exige siempre, y
 * los kinds de plan-1 (invoice/credit-memo/payment/rounding) no deben
 * empezar a fallar `GL_ACCOUNT_MAP_MISSING` sólo porque un ambiente todavía
 * no tiene sembrado `accounts_payable`/`inventory_offset` — `inventory_offset`
 * en particular no tiene ListID de QB real hoy (no existe una "Inventory
 * Offset Account" en el catálogo; alguien la tiene que crear en QB Desktop
 * antes de sembrar la fila). `loadPurchaseAccountMap` (accounts.ts) pide el
 * mapa base MÁS estas dos, sólo para los documentos de compras.
 */
export const PURCHASE_ACCOUNT_MAP_KEYS = [
  "accounts_payable",
  "inventory_offset",
] as const;
export type PurchaseAccountMapKey = (typeof PURCHASE_ACCOUNT_MAP_KEYS)[number];
export type PurchaseAccountMap = AccountMap &
  Record<PurchaseAccountMapKey, LedgerAccount>;

/**
 * Banking-on-GL §2/§6: sólo el documento `opening_balance` necesita
 * `opening_balance_equity`; fuera de `ACCOUNT_MAP_KEYS` por la misma razón que
 * las de compras — un ambiente sin sembrarla no rompe los demás documentos.
 */
export const OPENING_ACCOUNT_MAP_KEYS = ["opening_balance_equity"] as const;
export type OpeningAccountMapKey = (typeof OPENING_ACCOUNT_MAP_KEYS)[number];
export type OpeningAccountMap = AccountMap &
  Record<OpeningAccountMapKey, LedgerAccount>;

/** Una línea de invoice ya resuelta contra cuentas — el builder es puro, sin DB. */
export interface InvoiceLineSnapshot {
  quantity: number;
  /**
   * `COALESCE(pii.net_total_cents, pii.total)` SIN escalar — el PESO crudo de
   * la línea. `pos_invoice.subtotal` ya es NETO del descuento de orden
   * (medido contra producción: 107/108 invoices con discount cumplen
   * `total = subtotal + shipping + tax`), así que el income de cada línea se
   * reparte por mayor-resto sobre `subtotal + discount` (bruto), no se lee
   * de `net_total_cents` directo — esa columna es inconsistente entre
   * facturas (a veces ya trae el descuento de orden, a veces no).
   */
  lineNetCents: bigint;
  /** average_unit_cost en DÓLARES; null/0 → sin línea de COGS. */
  unitCostDollars: string | number | null;
  incomeAccount: LedgerAccount;
  /** null cuando la línea no tiene variant_id (sin COGS). */
  cogsAccount: LedgerAccount | null;
}

export interface InvoiceSnapshot {
  totalCents: bigint;
  /** `pos_invoice.subtotal` — YA NETO del descuento de orden. */
  subtotalCents: bigint;
  discountCents: bigint;
  shippingCents: bigint;
  taxCents: bigint;
  lines: InvoiceLineSnapshot[];
}

export interface CreditMemoLineSnapshot {
  quantity: number;
  damagedQty: number;
  lineTotalCents: bigint;
  unitCostDollars: string | number | null;
  incomeAccount: LedgerAccount;
  cogsAccount: LedgerAccount | null;
}

export interface CreditMemoSnapshot {
  totalCents: bigint;
  /** `pos_credit_memo.subtotal` — BRUTO, previo al descuento (medido: 3/3 cumplen total = subtotal − discount + shipping + tax). */
  subtotalCents: bigint;
  discountCents: bigint;
  shippingCents: bigint;
  taxCents: bigint;
  /** true si el memo entero es un write-off de fraude/bad debt (header-only). */
  isFraudWriteoff: boolean;
  lines: CreditMemoLineSnapshot[];
}

export interface PaymentSnapshot {
  type: "payment" | "refund";
  amountCents: bigint;
}

export type RoundingDirection = "shortage" | "overage";

export interface RoundingSnapshot {
  amountCents: bigint;
  direction: RoundingDirection;
  account: LedgerAccount;
}
