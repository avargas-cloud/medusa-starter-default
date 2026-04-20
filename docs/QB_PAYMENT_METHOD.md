# QuickBooks PaymentMethod Resolution

## The rule (canonical)

For every payment that syncs to QuickBooks — ReceivePayment, SalesReceipt, or legacy payment-captured paths — resolve the QB `PaymentMethodRef` with one function:

```ts
resolveQbPaymentMethodForPayment(paymentMethod, cardBrand)
```

**Rule:**
- If `paymentMethod === 'credit_card'` → send `cardBrand` (`Visa` / `MasterCard` / `American Express` / `Discover` / `Capital One`).
- Otherwise → send `paymentMethod` itself (`Debit Card` / `Cash` / `Check` / `Checking Account` / `Zelle` / ...).
- If nothing resolvable → return `undefined`, omit the `PaymentMethodRef` (prevents QB Error 3140 "invalid reference to QuickBooks PaymentMethod").

All `debit_card` transactions collapse to a single `"Debit Card"` bucket in QB regardless of card network. This preserves the credit-vs-debit distinction in QB accounting.

## Schema (split)

Both `pos_invoice` and `customer_payment` tables use a two-column split (shipped 2026-04-18):

| Column | Type | Values |
|--------|------|--------|
| `payment_method` | enum | `credit_card \| debit_card \| cash \| check \| ach \| zelle \| credit \| mixed` |
| `card_brand` | text nullable | `visa \| mastercard \| amex \| discover \| capital_one \| null` |

**Important:** `credit` = store credit (legacy meaning preserved — NOT a credit card). The credit-card value is `credit_card`.

## Code layout

```
backend/src/lib/quickbooks/
├── payment-method-sanitizer.ts       ← source of truth (sanitizer + helper)
└── handlers/
    ├── handle-pos-payment-created.ts ← ReceivePayment (POS, BAMS, manual)
    ├── handle-sales-receipt-created.ts ← SalesReceipt (POS V2 full-paid)
    └── handle-payment-captured.ts     ← edge path (non-POS web bypass)
```

### `payment-method-sanitizer.ts`

Two functions:

1. **`sanitizeToQbPaymentMethod(...candidates)`** — low-level alias resolver. Takes any number of raw strings (e.g. `"MASTERCARD"`, `"Visa Credit"`, `"capital_one"`) and returns the exact QB Desktop PaymentMethod name, or `undefined` for generic / unknown inputs.

2. **`resolveQbPaymentMethodForPayment(method, brand)`** — split-aware resolver. The function every handler should call. Applies the `credit_card → brand` / `else → method` rule on top of the sanitizer.

### Handlers

All three handlers prefer `resolveQbPaymentMethodForPayment`. The ReceivePayment handler additionally keeps a 6-candidate legacy cascade as belt-and-suspenders for any row that somehow escaped the 2026-04-18 backfill.

## Upstream gate (critical)

Before 2026-04-20, the POST `/admin/invoices` endpoint inserted `pos_invoice.payment_method` from `body.payment_method` (which can arrive stale during the Dejavoo auto-submit race) and only overrode in-memory variables afterward. The Sales Receipt handler later read the stale row and misclassified transactions.

**Fix:** the terminal_payment retrieve now runs **before** `createPosInvoices`:

```ts
// route.ts — pre-create override
let termPay: any = null;
if (body.terminal_payment_id) {
  termPay = await financeService.retrieveCustomerPayment(body.terminal_payment_id);
  const termPosMethod = termPay?.metadata?.pos_payment_method;
  const termCardBrand = termPay?.metadata?.card_brand ?? null;
  if (termPosMethod && termPosMethod !== normalizedPaymentMethod) {
    resolvedPaymentMethod = termPosMethod;
    resolvedCardBrand = termCardBrand;
  }
  // ... fallback for brand-only override
}

// Then createPosInvoices uses resolvedPaymentMethod / resolvedCardBrand
```

The `customer_payment.metadata.pos_payment_method` and `metadata.card_brand` fields written by the terminal capture route (`store-pos/.../bams/terminal/route.ts`) are the source of truth for the card detected at swipe time.

## Resolution map (live behavior)

| `payment_method` | `card_brand` | QB PaymentMethod |
|------------------|--------------|------------------|
| `credit_card` | `visa` | `Visa` |
| `credit_card` | `mastercard` | `MasterCard` |
| `credit_card` | `amex` | `American Express` |
| `credit_card` | `discover` | `Discover` |
| `credit_card` | `capital_one` | `Capital One` |
| `credit_card` | `null` | *(omitted — QB field blank)* |
| `credit_card` | unknown (`jcb`, etc.) | *(omitted)* |
| `debit_card` | *any* | `Debit Card` |
| `cash` | — | `Cash` |
| `check` | — | `Check` |
| `ach` | — | `Checking Account` |
| `zelle` | — | `Zelle` |
| `credit` *(store credit)* | — | *(omitted — not a QB payment method)* |

## Verifier

Run before any change to the sanitizer, the helper, or any handler branch:

```bash
cd backend && yarn medusa exec ./src/scripts/verify/verify-qb-payment-method-resolution.ts
```

Covers **40 synthetic scenarios** with no live QB calls, no bridge traffic, no DB writes:

- **17 direct** — `resolveQbPaymentMethodForPayment(method, brand)` across every supported combination.
- **23 handler-path** — mirrors of the production handlers (`handle-pos-payment-created.ts` + `handle-sales-receipt-created.ts`) across Terminal / BAMS webhook / Manual / Legacy / Edge sources.

Exits with code `1` if any case fails. The verifier is the first line of defense against regressions in the QB PaymentMethod pipeline.

## Adding a new brand or payment method

1. Update QuickBooks Desktop first: **Lists → Customer & Vendor Profile Lists → Payment Method List**. The name must match verbatim (casing sensitive).
2. Add the canonical key + name to `QB_PAYMENT_METHOD_NAMES` in `payment-method-sanitizer.ts`.
3. Add an alias regex to `ALIAS_PATTERNS` if raw inputs can arrive in multiple shapes.
4. Add coverage to `verify-qb-payment-method-resolution.ts` (both a direct helper test and a handler-path test).
5. Run the verifier. All cases must pass before deploying.

## Related docs

- [QB_INTEGRATION_BIBLE.md](./QB_INTEGRATION_BIBLE.md) — overall QB Bridge architecture.
- [QB_PIPELINE.md](./QB_PIPELINE.md) — `qb_order_pipeline` table + background sync.
- [FINANCE_PAYMENTS.md](./FINANCE_PAYMENTS.md) — `customer_payment` / `payment_application` model.
