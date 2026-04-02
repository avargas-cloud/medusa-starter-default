# Medusa Tax Calculation — Deep Research Notes
*Session: 2026-03-16 | DO NOT DELETE — Token checkpoint*

---

## The Core Problem
Orders with promotions (e.g., "google-review 5% OFF") show incorrect tax in the native Medusa admin:
- **FL (7.00%): $3.53** ← gross-based (wrong)
- **manual (7.00%): $3.53** ← duplicate! (also wrong)
- **Total: $7.07** ← should be **$3.36**

Correct tax: `7% × ($50.48 - $2.52) = $3.36`  
Legal basis: FL Rule 12A-1.003 — tax on post-discount selling price.

---

## Medusa's Tax Architecture (Fully Mapped)

### Step 1: `updateOrderTaxLinesWorkflow` (triggered by `order.placed`, `order-edit.confirmed`)
File: `@medusajs/core-flows/dist/order/workflows/update-tax-lines.js`

1. Fetches the order with `completeOrderFields` (which includes `items.unit_price`, `items.tax_lines.*`, etc.)
2. Calls `getItemTaxLinesStep` → calls `normalizeLineItemsForTax()` which passes items to the tax service
3. Tax service calls our `PosTaxProvider.getTaxLines()`
4. **Our provider IGNORES `unit_price`** — returns only `{rate: 7, code: 'FL', line_item_id: item.id}`
5. Calls `setOrderTaxLinesForItemsStep` which calls `orderService.upsertOrderLineItemTaxLines()`
6. This ONLY STORES `rate=7, code='FL'` in `order_line_item_tax_line` — **NO DOLLAR AMOUNT STORED here**

### Step 2: Tax Amount Computation (`decorateCartTotals`)
File: `@medusajs/utils/dist/totals/line-item/index.js` → `getLineItemTotals()`  
File: `@medusajs/utils/dist/totals/adjustment/index.js` → `calculateAdjustmentTotal()`

```javascript
// getLineItemTotals already computes discount-aware tax!
const taxTotal = calculateTaxTotal({
    taxLines: item.tax_lines,
    taxableAmount: MathBN.sub(currentSubtotal, currentDiscountsSubtotal), // ← discount aware!
});
```

`currentDiscountsSubtotal` = sum of `item.adjustments[].amount`  
**If `item.adjustments` is EMPTY → `currentDiscountsSubtotal = 0` → tax on gross = $3.53**

> **IMPORTANT**: `calculateAdjustmentTotal` expects adjustment amounts to be **POSITIVE** values
> (e.g., `+2.399` for a $2.399 discount). The formula subtracts them: `gross - positiveAdj = net`.
> If stored as negative (which is our assumption), the math inverts and increases the taxable amount.

### Step 3: Where `order_summary.totals` comes from
File: `@medusajs/order/dist/services/order-module-service.js`

- `addRelationsToCalculateTotals()` (line 190) populates `requiredRelationsForTotals`:
  ```javascript
  ["credit_lines", "items", "items.tax_lines", "items.adjustments",
   "shipping_methods", "shipping_methods.tax_lines", "shipping_methods.adjustments"]
  ```
- `"items.adjustments"` is in this list — BUT may map through `transform-order.js` to the wrong relation

- `order_summary.totals` is only **written** during:
  1. `createOrders_()` — initial order creation
  2. Order edit confirmation (`applyChangesToOrder()` → `decorateCartTotals()` → stored in summary)

- `updateOrderTaxLinesWorkflow` **does NOT update `order_summary.totals`** — it only writes rates!

### Step 4: `setOrderTaxLinesForItemsStep`
File: `@medusajs/core-flows/dist/order/steps/set-tax-lines-for-items.js`

```javascript
// This is ALL it does — ZERO order summary recalculation:
await orderService.upsertOrderLineItemTaxLines([{
    rate: 7, code: 'FL', item_id: 'orli_...', provider_id: 'pos-tax'
}])
```

---

## Why There Are TWO Tax Lines (FL + manual)

The `us-fl` sub-region tax rate (Medusa native `tp_system` provider) was supposed to be deleted via the Admin API. However, something (soft-delete or re-creation) is causing `manual (7.00%)` lines to still appear.

The manual lines double the tax: $3.53 × 2 = $7.07.

**Subscriber** (`src/subscribers/tax-fix-subscriber.ts`) runs on `order.placed` + `order-edit.confirmed` and DELETEs rows from `order_line_item_tax_line` where `code NOT IN ('FL', 'FL-SHIPPING', 'EXEMPT')`.
→ This WORKS (column `code` exists), deletes the `manual` lines.
→ But `order_summary.totals` is NOT recalculated after this delete.

---

## What We Tried and Why It Failed

### Attempt 1: Patch `normalizeLineItemsForTax` in `get-item-tax-lines.js`
**Why it doesn't work**: Our `PosTaxProvider` ignores `unit_price` entirely and returns `rate=7`. The modified `unit_price` we passed has zero effect on the stored rate or the computed amounts.

**Side effect**: Adding `items.adjustments.*` to `update-tax-lines.js` query caused the discount total to change from $2.52 → $2.67 on Save. Reason: the extra fields in the workflow query affected how adjustments were processed by `setOrderTaxLinesForItemsStep` internally.

**Status**: REVERTED. `normalizeLineItemsForTax` is back to Medusa original. `update-tax-lines.js` has no extra fields.

---

## Why `item.adjustments` Might Be Empty at Tax Compute Time

The hypothesis: when `order-edit.confirmed` runs `updateOrderTaxLinesWorkflow`, the items might not have their adjustments loaded properly.

In Medusa v2:
- `order.items` = `OrderItem[]` (junction table: `order_item`)
- `OrderItem.item` = `OrderLineItem` (the actual `order_line_item` record)  
- Promotions create records in `order_line_item_adjustment` linked to `OrderLineItem`
- The MikroORM path `items.adjustments` might load `OrderItem.adjustments` (junction level = empty)
  rather than `items.item.adjustments` (line item level = actual promotion data)
- Note: `transform-order.js` remaps some fields but `adjustments` behavior is unclear

**Evidence**: Tax = $3.53 (gross) = 7% × $50.48 = proves `currentDiscountsSubtotal = 0` = adjustments empty.

---

## Current State of Files

| File | Status |
|------|--------|
| `patches/@medusajs+core-flows+2.13.0.patch` | Contains OLD patch (get-orders-list + summary) + needs regeneration |
| `node_modules/@medusajs/core-flows/dist/tax/steps/get-item-tax-lines.js` | **REVERTED** to original Medusa |
| `node_modules/@medusajs/core-flows/dist/order/workflows/update-tax-lines.js` | **REVERTED** — no adjustments fields |
| `src/subscribers/tax-fix-subscriber.ts` | Deletes non-FL lines; does NOT update order_summary |
| `docs/MEDUSA_PATCH_TAX_DISCOUNT_AWARE.md` | Outdated — describes the wrong approach |

---

## The CORRECT Fix — ✅ IMPLEMENTED (Marzo 16, 2026)

> **STATUS: DONE.** The approaches below were implemented via custom SQL injection endpoints instead of patching Medusa internals.

### What Was Actually Done (Option A variant — SQL Direct)

Instead of updating `order_summary.totals` via subscriber, the solution uses dedicated endpoints that:
1. DELETE existing tax lines (stale FL + EXEMPT)
2. INSERT correct tax lines based on `pos_tax_rate`
3. UPDATE `order_summary.totals` JSONB directly via SQL

This is cleaner than Option A (no subscriber timing issues) and bypasses Option B (no Medusa core patches needed).

#### Implemented Files

| File | What It Does |
|------|--------------|
| `orders/[id]/post-edit-sync/route.ts` | Reads `pos_tax_amount` \+ `pos_tax_rate`, inserts EXEMPT or FL lines, patches `order_summary.totals` |
| `orders/[id]/apply-discount-force/route.ts` | Accepts `pos_tax_rate`, DELETE old lines, INSERT correct (EXEMPT/FL), confirm edit |
| `draft-orders/[id]/convert-force/route.ts` | Step 7a reads `metadata.tax_mode` → EXEMPT (0%) or FL (7%) injection at order creation |
| `draft-orders/[id]/add-shipping-force/route.ts` | **Rewritten** — replaces `addDraftOrderShippingMethodsWorkflow` (fails on null tax provider) with direct SQL INSERT |

#### Root Cause of `AwilixResolutionError: null` (add-shipping-force)

```
SELECT id, country_code, provider_id FROM tax_region;
  txreg_01KHVFD77F9190Q71Y4ZAS52E2 | us    |   ← empty string (not null but resolves as null)
  txreg_01KHVFFVKJMNB4ZNRNYYB99FTZ | us-fl |   ← empty string + check constraint prevents update
```

- `tax_region.provider_id` is empty string/null for both US and US-FL regions
- `addDraftOrderShippingMethodsWorkflow` internally calls `getTaxLines` → `getTaxLinesFromProvider` → `retrieveProvider(null)` → **AwilixResolutionError**
- Cannot fix via `UPDATE tax_region SET provider_id = 'tp_pos-tax'` because:
  - `FK_tax_region_provider_id`: `tp_pos-tax` not in `tax_provider` table (the identifier would need to be registered first)
  - `CK_tax_region_provider_top_level`: sub-regions (us-fl) cannot have a provider
- **Solution**: bypass the workflow entirely with direct SQL (same pattern as tax line injection)

### Option A: Update `order_summary.totals` JSONB in subscriber (Recommended)

After the subscriber deletes the manual lines, **also update `order_summary.totals`** via SQL:

```sql
-- Get the correct tax from metadata
-- metadata.computed_tax_amount = $3.36 (calculated discount-aware by compute-tax route)

UPDATE order_summary
SET totals = totals 
    || jsonb_build_object(
        'tax_total', $correct_tax,
        'item_tax_total', $correct_tax,
        'original_tax_total', $gross_tax,
        'total', $correct_total
    )
WHERE order_id = $order_id
ORDER BY version DESC
LIMIT 1
```

First need to query one `order_summary.totals` row to see all available keys:
```sql
SELECT totals FROM order_summary WHERE order_id = 'order_01KKVYW3RW0EF0VX8BNGCS042X' 
ORDER BY version DESC LIMIT 1;
```

The DB query for this has been timing out. Need to fix connection (possibly via psql CLI directly).

### Option B: Fix `requiredRelationsForTotals` to load actual adjustments

In `@medusajs/order/dist/services/order-module-service.js`, change:
```javascript
"items.adjustments",  // ← might load wrong relation (junction level)
```
to:
```javascript
"items.item.adjustments",  // ← correct path to order_line_item_adjustment
```

But this requires modifying `@medusajs+order+2.13.0.patch` (the EXISTING patch for this package). The transformation in `transform-order.js` would also need to correctly expose the adjustments as `item.adjustments` in `getLineItemTotals`.

### Option C: Accept Medusa's display limitation

- Delete `manual` lines via subscriber (already implemented ✅)
- Payment collection uses `metadata.computed_total` = correct ✅
- POS uses `computeTotals()` = correct ✅
- Native admin will show `$3.53` (still wrong by $0.17) but no longer $7.07

---

## Action Plan for Next Session — ✅ COMPLETED (Marzo 16, 2026)

1. ~~**CRITICAL**: Run this SQL to see `order_summary.totals` structure~~ ✓ Done via `post-edit-sync`
2. ~~Once structure is known, **implement subscriber JSONB update** (Option A above)~~ ✓ Done via direct SQL in endpoints
3. ~~**Regenerate patch file**~~ – Not needed (no Medusa core patches)
4. ~~**Restart backend**~~ ✓ Done
5. ~~**Test**: Click Save on an order with discount and verify:~~ ✓ All 3 escenas verified:
   - Escena 1 (Estimate → Order): Tax correct at FL 7% AND 0% EXEMPT ✓
   - Escena 2 (Direct Order from POS): Shipping fix (SQL bypass) ✓
   - Escena 3 (Edit existing Order): Tax correct EXEMPT overwrite ✓

**New Known Issue for Future:**
- `tax_provider` table doesn't have `tp_pos-tax` registered — if Medusa ever needs native tax calculation, the provider needs to be properly registered via Medusa's module system (not direct DB insert)

---

## Key Files Reference (Updated Marzo 16, 2026)

```
backend/src/subscribers/tax-fix-subscriber.ts          ← deletes non-FL/EXEMPT lines on order.placed
backend/src/api/admin/draft-orders/[id]/compute-tax/route.ts  ← saves computed_tax_amount to metadata
backend/src/api/admin/draft-orders/[id]/convert-force/route.ts ← reads metadata.tax_mode → injects FL/EXEMPT
backend/src/api/admin/draft-orders/[id]/add-shipping-force/route.ts ← REWRITTEN: SQL direct (no workflow)
backend/src/api/admin/orders/[id]/post-edit-sync/route.ts ← patches order_summary + injects tax lines
backend/src/api/admin/orders/[id]/apply-discount-force/route.ts ← dynamic FL/EXEMPT, accepts pos_tax_rate
backend/src/modules/pos-tax/service.ts                 ← returns rate=7 or 0 for customer groups
```

---

## Key Medusa Architecture Understood

- `order_line_item_tax_line`: stores `rate` (7%) only. NO `amount` column.
- `order_summary.totals`: JSONB blob with computed totals — THIS is what admin displays.
- `decorateCartTotals()`: computes tax on `gross - adjustments` IF adjustments are loaded.
- `getLineItemTotals()`: computes `tax_total` (discounted) AND `original_tax_total` (gross).
- The admin likely shows `order_summary.totals.tax_total` (which might be gross if adjustments never loaded).
- `updateOrderTaxLinesWorkflow` does NOT update `order_summary` — it only stores rates.
- Only order creation and order edit confirmation update `order_summary.totals` via `applyChangesToOrder()`.
