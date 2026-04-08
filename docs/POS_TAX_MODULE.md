# POS Tax Module
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What it is and why it exists

The `pos-tax` module is a **custom Medusa v2 Tax Provider** that implements a hardcoded Florida Sales Tax rule for the POS channel. It replaces the default Medusa tax engine for the POS sales channel and handles two scenarios: taxable customers (7% Florida Sales Tax) and tax-exempt customers (0%).

It exists because:
- Medusa's built-in tax regions require complex region/zone setup for a single-state operation
- The POS operates exclusively in Florida (7% combined state+county rate)
- Tax exemptions must be handled at the customer group level, not via region configuration
- Florida law exempts shipping from sales tax — this provider encodes that rule directly

---

## Architecture

Registered in `medusa-config.ts` as a provider under the `@medusajs/medusa/tax` module:

```typescript
{
  resolve: "@medusajs/medusa/tax",
  options: {
    providers: [
      { resolve: "./src/modules/pos-tax", id: "pos-tax" }
    ]
  }
}
```

Implements the `ITaxProvider` interface from `@medusajs/framework/types`.

---

## Tax Calculation Logic

### Exemption Check (evaluated first)

A customer is considered **tax-exempt** if either condition is true:
1. The customer belongs to a group whose `name` is `"tax-exempt"` (case-insensitive, partial match on "exempt")
2. The shipping address metadata contains `tax_mode: "exempt"`

When exempt, **all item lines** return rate `0%` using the US Exempt Tax Rate (`txr_01KHVFD7C5N2X6ZDFFNVT0Q3N9`).

### Normal Flow — Florida 7%

All item lines are taxed at **7%** using the Florida Sales Tax Rate ID (`txr_01KHVFFVRFRG3R0DZNPXSWMQB0`).

### Shipping Tax

Shipping is **not taxed** — Florida law exempts shipping charges from sales tax. No explicit 0% lines are returned for shipping; Medusa defaults to $0 tax when no lines are provided for a shipping line.

---

## Hardcoded Tax Rate IDs

These IDs reference real Tax Rate records in the Medusa database:

| ID | Description | Rate |
|----|-------------|------|
| `txr_01KHVFFVRFRG3R0DZNPXSWMQB0` | Florida Sales Tax | 7% |
| `txr_01KHVFD7C5N2X6ZDFFNVT0Q3N9` | US Sales Tax (Exempt) | 0% |

**Critical**: These IDs must exist in the database. If the Tax Rates are ever recreated, these constants must be updated in `service.ts`.

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| Service | `backend/src/modules/pos-tax/service.ts` | Tax provider implementation |
| Index | `backend/src/modules/pos-tax/index.ts` | Module registration |
| Migrations | `backend/src/modules/pos-tax/migrations/` | DB migrations (if any) |
| Config | `backend/medusa-config.ts` | Provider registration |

---

## Rules

- Never add additional rates or regions — the single Florida rate is intentional
- The `US_EXEMPT_TAX_RATE_ID` must be a real 0% rate in the Admin panel, not a fabricated ID
- The exemption group check uses `.toLowerCase().includes("exempt")` — any group name containing "exempt" qualifies
- Shipping is exempt from Florida sales tax by law — do not add shipping tax lines

---

## POS Frontend: Tax State (store-pos)

This is a separate but related behavior implemented entirely in the POS frontend. The backend tax provider handles checkout cart calculations; the following covers how the POS UI manages tax state for orders and estimates.

### Design principle

Tax state is **captured from the customer at selection time** and stored in the document. The document owns its own tax state independently — the cashier can override it at any time via the Summary dropdown. If the override differs from what's stored in the customer's metadata, a **"↑ Save as Cust."** button appears to persist the change back to the customer permanently.

---

### Step 1 — Customer added to document

When the cashier assigns a customer, `selectCustomer()` in `CustomerStrip.tsx` reads `customer.metadata.is_tax_exempt`:

```typescript
// store-pos/app/(pos)/orders/[id]/components/CustomerStrip.tsx  (lines 158–164)
// store-pos/app/(pos)/estimates/[id]/components/CustomerStrip.tsx  (identical)
const exemptRaw = fullMeta.is_tax_exempt
const isExempt = exemptRaw === true ||
    String(exemptRaw ?? '').toLowerCase() === 'yes' ||
    String(exemptRaw ?? '').toLowerCase() === 'true'
return { taxMode: isExempt ? 'exempt' : 'florida', taxEnabled: !isExempt, taxRate: isExempt ? 0 : 7 }
```

Result is written to the POS store via `setDocument({ taxMode, taxEnabled, taxRate })`.

---

### Step 2 — Tax state persisted to document metadata

When the document is saved, tax state is written to the order/draft order as:
- `metadata.tax_enabled` (`boolean`)
- `metadata.tax_rate` (`number` — `7` or `0`)
- `metadata.tax_mode` (`"florida"` | `"exempt"`)

On page reload, `useOrderData.ts` / `useEstimateData.ts` restores from these metadata fields (not from the customer object):

```typescript
// store-pos/app/(pos)/estimates/[id]/hooks/useEstimateData.ts  (lines 148–152)
taxMode:    (!alreadyHydrated ? (o.metadata?.tax_mode === 'exempt' ? 'exempt' : 'florida') : current.doc.taxMode),
taxEnabled: (!alreadyHydrated ? (o.metadata?.tax_enabled ?? true)                          : current.doc.taxEnabled),
taxRate:    (!alreadyHydrated ? ((o.metadata?.tax_rate as number) ?? 7)                    : current.doc.taxRate),
```

The `!alreadyHydrated` guard ensures tax is only seeded from metadata on the first load; subsequent re-renders keep in-memory state unchanged.

---

### Step 3 — Cashier can override tax mid-session

In `OrderSummary.tsx`, the tax row contains a **dropdown button** showing the current tax mode (`Florida (7%)` or `Tax Exempt`). The cashier can change it at any time:

```
Tax   [Florida (7%) ▾]   ↑ Save as Cust.     $X.XX
```

Selecting an option calls `setDocument({ taxMode, taxEnabled, taxRate })` immediately — the document's tax recalculates on the next render.

---

### Step 4 — "↑ Save as Cust." — persisting change back to the customer

`OrderSummary.tsx` compares `doc.taxMode` against `customerData.customer.metadata.default_tax` (fetched live from the backend, cached 60s):

```typescript
const customerDefaultTax = customerData?.customer?.metadata?.default_tax ?? ''

{doc.customerId && doc.taxMode !== customerDefaultTax && (
    <button onClick={saveTaxDefault}>↑ Save as Cust.</button>
)}
```

When the cashier clicks **"↑ Save as Cust."**:

```typescript
// PATCH /admin/customers/:id
body: { metadata: { default_tax: doc.taxMode } }   // "florida" | "exempt"
```

This overwrites `customer.metadata.default_tax` on the backend. The next time this customer is added to any document, `selectCustomer()` will read the updated value and pre-set the correct tax mode automatically.

> **Note:** `default_tax` (`"florida"` | `"exempt"`) is the field used for the comparison. `is_tax_exempt` (`true`/`"yes"`) is the field read at selection time. Both coexist on the customer metadata.

---

### Tax sources summary

| Source | Field | When used |
|--------|-------|-----------|
| Customer metadata at selection | `is_tax_exempt` (`true`/`"yes"`) | Sets initial `taxMode` when customer is added |
| Customer metadata for comparison | `default_tax` (`"florida"`/`"exempt"`) | Determines whether "↑ Save as Cust." is shown |
| Document metadata | `tax_mode` / `tax_enabled` / `tax_rate` | Restored on page reload |
| POS store state | `doc.taxMode` | Drives all UI and `computeTotals()` |

### Totals calculation

`computeTotals()` in `store/posStore.ts` reads only from document state — never from the customer:

```typescript
const isExempt = doc.taxMode === 'exempt'
const taxRate  = isExempt ? 0 : 0.07
```

---

### Affected files

| File | Role |
|------|------|
| `store-pos/app/(pos)/orders/[id]/components/CustomerStrip.tsx` | Reads `is_tax_exempt` at selection, writes `taxMode` to document |
| `store-pos/app/(pos)/estimates/[id]/components/CustomerStrip.tsx` | Identical logic for estimates |
| `store-pos/components/pos/CustomerSelector.tsx` | Simplified tax check for quick POS selector |
| `store-pos/app/(pos)/orders/[id]/hooks/useOrderData.ts` | Restores tax from `metadata` on first load only |
| `store-pos/app/(pos)/estimates/[id]/hooks/useEstimateData.ts` | Same as above for estimates |
| `store-pos/store/posStore.ts` | `POSDocument` owns `taxEnabled/taxRate/taxMode`; `computeTotals()` uses them |
| `store-pos/components/pos/OrderSummary.tsx` | Tax dropdown + "↑ Save as Cust." button; writes `default_tax` back to customer |
