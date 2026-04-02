# POS Discount & Promotions API
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What it is and why it exists

The POS uses two separate admin API endpoints for applying discounts to draft orders (estimates):

1. **`/admin/pos-discount`** — creates a **new, ad-hoc discount** (percent or fixed amount) on the fly and applies it via a Draft Order Edit workflow
2. **`/admin/pos-promotions`** — lists **existing, pre-configured Medusa promotions** (coupon codes) that can be applied to an order

These endpoints exist because:
- The standard Medusa promotion apply flow requires a `code` entered by a customer — the POS needed a way for staff to apply a custom discount amount without a pre-existing promotion code
- The Draft Order Edit workflow is required to mutate an active draft order — direct order mutation is not allowed by Medusa
- POS-generated discount codes use the prefix `POS-DISC*` to distinguish them from customer-facing coupons

---

## `/admin/pos-discount`

### `POST /admin/pos-discount` — Apply Ad-hoc Discount

Creates a real Medusa promotion and applies it to a draft order in a single flow.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `order_id` | string | Yes | Draft order ID (`order_XXXXX`) |
| `discount_type` | `'percent'` or `'fixed'` | Yes | Discount mode |
| `discount_value` | number | Yes | Percentage (e.g., 5 for 5%) or dollar amount |
| `existing_promo_code` | string | No | Previous custom promo code to remove before applying new one |

**Workflow:**
1. Fetch order for `currency_code`
2. Create Medusa promotion with code `CUSTOM-DISC-{timestamp}`
3. Cancel any pending draft order edits
4. Begin new draft order edit
5. Remove `existing_promo_code` (if provided)
6. Apply new promotion
7. Confirm edit

**Response:**
```json
{ "success": true, "promotion_code": "CUSTOM-DISC-1234567890", "promotion_id": "promo_xxx" }
```

**Critical implementation notes:**
- `is_tax_inclusive: false` — percentage is applied to pre-tax subtotal only
- `target_type: "items"` — targets unit_price × qty (not subtotal+tax)
- The generated promo code is stored in the draft order and must be passed back as `existing_promo_code` when updating the discount

### `DELETE /admin/pos-discount` — Remove Discount

Removes a promotion from a draft order.

**Request Body:**

| Field | Type | Required |
|-------|------|----------|
| `order_id` | string | Yes |
| `promotion_code` | string | No |

Same workflow: cancel edit → begin edit → remove promo → confirm edit.

---

## `/admin/pos-promotions`

### `GET /admin/pos-promotions` — List Available Promotions

Lists all non-automatic Medusa promotions **excluding** POS-generated discount codes (those starting with `POS-DISC`).

Returns the promotions available to display in the POS "Apply Coupon" dropdown — these are real coupon codes created in the Medusa admin panel (e.g., `SUMMER20`, `WHOLESALE10`).

**Response:**
```json
{ "promotions": [ { "id": "promo_xxx", "code": "SUMMER20", "application_method": {...} } ] }
```

### `POST /admin/pos-promotions/apply-existing` — Apply Existing Promotion

Applies a pre-existing coupon code to a draft order using the same Draft Order Edit workflow as pos-discount.

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| POS Discount Route | `backend/src/api/admin/pos-discount/route.ts` | POST/DELETE ad-hoc discounts |
| POS Promotions Route | `backend/src/api/admin/pos-promotions/route.ts` | GET existing promotions |
| Apply Existing Route | `backend/src/api/admin/pos-promotions/apply-existing/route.ts` | Apply pre-existing coupon |

---

## Rules

- Never apply a promotion directly to an order without the Draft Order Edit workflow — Medusa enforces immutability on active orders
- The `promotion_code` field in the POS state should be persisted in the React component and passed back on the next discount update as `existing_promo_code`
- Custom POS discount codes use `CUSTOM-DISC-{timestamp}` format (not `POS-DISC*` — that prefix was planned but not implemented in the current code)
- Fixed discounts require `currency_code` — always fetch the order first
