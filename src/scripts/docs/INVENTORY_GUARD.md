# INVENTORY_GUARD.md
# Inventory Guard: Web Store vs POS — Sales Channel Strategy

**Status**: ✅ Implemented  
**Date**: 2026-03-05  
**Files**:
- `src/workflows/hooks/validate-web-store-inventory.ts` — the guard hook
- `src/scripts/create/create-pos-sales-channel.ts` — creation script (already run)

---

## Problem

All product variants have `allow_backorder = true` (required for POS/Admin workflows
where reps can sell against purchase orders). However, self-service web store customers
at `ecopowertech.com` must NOT be allowed to buy out-of-stock items.

A backend-only solution was required because frontend-only checks are bypassable and
subject to race conditions.

---

## Architecture

```
allow_backorder = true  (all variants — do NOT change this)
                │
      ┌─────────┴──────────────┐
      │                        │
 Web Store                  POS / Admin
 ecopowertech.com           pos.ecopowertech.com
 Sales Channel: DEFAULT     Sales Channel: POS
      │                        │
 completeCartWorkflow       createDraftOrderWorkflow
 + validate hook            (completely separate — hook never fires)
      │
 Strict inventory check
 → MedusaError if OOS
 → Order NOT created
```

---

## Sales Channels

| Channel | ID | Domain | Restriction |
|---|---|---|---|
| Default Sales Channel (Web Store) | `sc_01KFH7QCHT364SX242A69ZR435` | ecopowertech.com | OOS blocked at checkout |
| POS | `sc_15154EAF0D194265ADD21AAD2D` | pos.ecopowertech.com | Backorder always allowed |

**Environment variables** (set in `.env` and Railway):
```
WEB_STORE_SALES_CHANNEL_ID=sc_01KFH7QCHT364SX242A69ZR435
POS_SALES_CHANNEL_ID=sc_15154EAF0D194265ADD21AAD2D
```

---

## How the Hook Works

File: `src/workflows/hooks/validate-web-store-inventory.ts`

Hooks into `completeCartWorkflow.hooks.validate` — fires server-side immediately
before the order is created, after payment is authorized.

**Logic:**
1. Fetches the cart with its `sales_channel_id` and all variant inventory data
2. If `sales_channel_id !== WEB_STORE_CHANNEL_ID` → exits immediately (POS free pass)
3. For each cart item, sums `stocked_quantity - reserved_quantity` across all inventory items
4. If any item has `requested_qty > available_qty` → throws `MedusaError(NOT_ALLOWED)`
5. Medusa's workflow rollback mechanism automatically releases any reservations on failure

**Race condition handling**: Standard e-commerce approach — first checkout wins.
If two customers have the last item, the one who completes checkout first gets it.
The other receives a clear error message and the item is flagged OOS in their cart.

---

## What Is NOT Affected

| Flow | Affected? |
|---|---|
| Admin Panel draft orders | ❌ No — uses `createDraftOrderWorkflow` |
| Admin Panel order conversion | ❌ No — uses `createOrderFromDraftOrderWorkflow` |
| POS cart checkout | ❌ No — `sales_channel_id` check exits early |
| QuickBooks sync | ❌ No — backend-to-backend, no cart flow |

---

## Frontend Layer (ecopowertech.com — Astro)

The frontend already has a UX-level inventory guard in `ProductAddToCart.tsx`:

```typescript
const isOutOfStock = variant.inventory_quantity === 0;       // disables button
const isOverStock = quantity > variant.inventory_quantity;   // blocks submit
max={variant.inventory_quantity}                             // caps the counter
```

This is a cosmetic/UX layer. The backend hook is the real enforcement.

---

## POS Frontend Requirements

When the POS creates a cart, it MUST include the POS sales channel ID:

```typescript
// POST /store/carts
{
  sales_channel_id: process.env.NEXT_PUBLIC_SALES_CHANNEL_ID
  // → sc_15154EAF0D194265ADD21AAD2D
}
```

Add to POS Vercel environment variables:
```
NEXT_PUBLIC_SALES_CHANNEL_ID=sc_15154EAF0D194265ADD21AAD2D
```

Alternatively, if the POS uses Admin API routes (`/admin/draft-orders`) instead of
Store cart routes, no sales channel configuration is needed — the hook never fires.

---

## Logs to Watch

When the backend is running, watch for these log prefixes:

```
[inventory-guard] Web Store cart xxx — running inventory check
[inventory-guard]   "Product Title" → requested: 2, available: 1
[inventory-guard] ❌ Blocking checkout — OOS items: ...
[inventory-guard] ✅ All items in stock — checkout allowed
[inventory-guard] Channel sc_xxx is POS — backorder ALLOWED, skipping check
```
