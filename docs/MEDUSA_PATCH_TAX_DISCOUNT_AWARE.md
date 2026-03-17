# Medusa Core Tax Patch — Discount-Aware Tax Calculation

**Applied:** 2026-03-16  
**Package:** `@medusajs/core-flows@2.13.0`  
**Managed by:** `patch-package` → `patches/@medusajs+core-flows+2.13.0.patch`

---

## Problem

Medusa's `updateOrderTaxLinesWorkflow` computes tax on the **gross unit price**, completely ignoring promotion adjustments (order-level or item-level discounts).

**Example (Order #1107):**
- Subtotal: $50.48 | 5% google-review promo → $2.52 discount
- Medusa native tax: `7% × $50.48 = $3.53` ❌ (gross price — overcharges customer)
- Correct tax (FL law): `7% × $47.96 = $3.36` ✅ (post-discount price)

## Legal Basis

Florida Administrative Code Rule 12A-1.003 (and most US jurisdictions) requires sales tax to be applied to the **selling price after discounts**. Using gross price overstates tax liability.

## Root Cause

In `@medusajs/core-flows/dist/tax/steps/get-item-tax-lines.js`, the `normalizeLineItemsForTax()` function builds the item data passed to the tax provider:

```javascript
// BEFORE PATCH (Medusa default)
function normalizeLineItemsForTax(orderOrCart, items) {
    return items.map((item) => ({
        unit_price: item.unit_price,  // ← GROSS price, ignores adjustments
        quantity: item.quantity,
        // ...
    }));
}
```

The tax provider receives the `unit_price` and computes `rate × unit_price × qty`. Since `item.adjustments` was never fetched or considered, the tax was always on the gross price.

## Fix Applied (2 files)

### File 1: `dist/tax/steps/get-item-tax-lines.js`

`normalizeLineItemsForTax()` now computes the discount-adjusted `unit_price`:

```javascript
// AFTER PATCH
function normalizeLineItemsForTax(orderOrCart, items) {
    return items.map((item) => {
        const grossSubtotal = Number(item.unit_price) * Number(item.quantity);
        const totalAdj = (item.adjustments || [])
            .reduce((sum, adj) => sum + Number(adj.amount || 0), 0);
        // Adjustments are stored as NEGATIVE values in Medusa v2
        const adjustedSubtotal = Math.max(0, grossSubtotal + totalAdj);
        const adjustedUnitPrice = adjustedSubtotal / Number(item.quantity);
        return {
            unit_price: adjustedUnitPrice,  // ← discount-aware
            quantity: item.quantity,
            // ...
        };
    });
}
```

### File 2: `dist/order/workflows/update-tax-lines.js`

Added `adjustments` to both `completeOrderFields` and `lineItemFields` so the data is fetched by the workflow's GraphQL queries:

```javascript
"items.adjustments.id",
"items.adjustments.amount",
"items.adjustments.promotion_id",
```

## Adjustment Amount Sign Convention

In Medusa v2, promotion adjustments are stored as **negative values**:
- Discount reduces price → `adjustment.amount = -$2.399` for a $2.399 discount
- Formula: `adjustedSubtotal = grossSubtotal + sum(adjustments.amount)` = net price

**⚠️ If this ever changes to positive values**, the formula `grossSubtotal + totalAdj` would INCREASE the taxable base instead of decreasing it. Symptom: computed tax would EXCEED the gross-based tax. Fix: change `+ totalAdj` to `- Math.abs(totalAdj)`.

## How `patch-package` Works

The patch is stored as a git diff in `patches/@medusajs+core-flows+2.13.0.patch`. It is re-applied automatically on every `yarn install` via:

```json
"scripts": {
    "postinstall": "patch-package",
    "build": "medusa build && node scripts/post-build.js"
}
```

### Railway / Railpack Deployment (VERIFIED 2026-03-17)

> **⚠️ CRÍTICO:** Railpack (Railway's builder) ignora `nixpacks.toml` completamente.  
> La única forma de customizar el build es via el script `"build"` en `package.json`.

El flujo en Railway es:

```
1. yarn install --frozen-lockfile
   → postinstall: patch-package  (aplica patches al build workspace)

2. npm run build
   → medusa build  (genera .medusa/server/ con npm install FRESCO — borra patches!)
   → node scripts/post-build.js:
       • Copia patches/ → .medusa/server/patches/
       • Inyecta "postinstall": "npx --yes patch-package" en .medusa/server/package.json
       ⚠️ NO ejecuta patch-package aquí — node_modules no existen aún en build time.

3. cd .medusa/server && npm install --omit=dev --legacy-peer-deps
   → postinstall: npx --yes patch-package   ← AQUÍ se aplican en producción ✅
   → @medusajs/core-flows@2.13.0 ✔
   → @medusajs/order@2.13.0 ✔
```

**Gotcha — Watch Paths:** Railway solo hace deploy cuando cambian `/src/**`, `package.json`, etc.  
Si editas solo `scripts/post-build.js` (archivo `.js`), **no se triggerea el deploy**.  
Solución: también bumpa la versión en `package.json` para forzar el redeploy.

## Affected Workflows

Any workflow that calls `updateOrderTaxLinesWorkflow` will now compute discount-aware tax:
- `order.placed` → convert draft to order
- `order-edit.confirmed` → order edit confirmation
- `createOrderWorkflow` → new order creation

## Testing

After restart, create an order with a promotion discount. Verify:
- Medusa admin tax = `rate × discounted_subtotal` (not gross)
- POS ComputeTotals output = same value (should now match natively)
- Payment collection = correct total

## Version Upgrade Risk

If `@medusajs/core-flows` is upgraded past 2.13.0:
1. Run `yarn install` — patch-package will warn if the patch fails to apply
2. Re-inspect the new `get-item-tax-lines.js` and manually apply the same logic change
3. Regenerate the patch with `npx patch-package @medusajs/core-flows`
