# Wholesale Pricing Management Scripts

## Scripts Overview

### 1. Add Wholesale Prices
**File:** `add-wholesale-prices.ts`
**Purpose:** Creates 7.5% discounted prices in the wholesale price_list

```bash
npx medusa exec ./add-wholesale-prices.ts
```

**What it does:**
- Finds all base retail prices ($60.99)
- Calculates 7.5% discount (→ $56.42)
- Adds discounted prices to "Wholesale Pricing" price_list
- Wholesale customers will see discounted prices

### 2. Remove Wholesale Prices
**File:** `remove-wholesale-prices.ts`
**Purpose:** Removes all wholesale prices, keeping only retail

```bash
npx medusa exec ./remove-wholesale-prices.ts
```

**What it does:**
- Deletes all prices in "Wholesale Pricing" price_list
- Everyone sees only retail prices ($60.99)
- Use this to revert if wholesale pricing causes issues

## Pricing Structure

### Current State: Retail Only
- ✅ Base prices: $60.99 (all customers)
- ❌ No wholesale prices yet

### After Adding Wholesale
- ✅ Base prices: $60.99 (anonymous & retail customers)
- ✅ Wholesale prices: $56.42 (logged-in wholesale customers)

## Troubleshooting

### If wholesale customers see retail prices:
1. Check customer is in "Wholesale" customer group
2. Verify price_list has customer_group rule
3. Check `calculatePrices()` receives customer_group_id in context

### If everyone sees wholesale prices:
1. Run `remove-wholesale-prices.ts`
2. Ensure base prices have `price_list_id: null`
3. Check only wholesale prices are in price_list

## Safe Workflow

```bash
# 1. Add wholesale pricing
npx medusa exec ./add-wholesale-prices.ts

# 2. Test with wholesale customer login
# Visit product page, should see $56.42

# 3. If something breaks, revert immediately
npx medusa exec ./remove-wholesale-prices.ts
```
