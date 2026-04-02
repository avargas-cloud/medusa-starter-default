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
