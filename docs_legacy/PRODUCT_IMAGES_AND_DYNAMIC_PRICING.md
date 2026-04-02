# Product Images & Dynamic Pricing Fix


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Document the February 2026 fixes for product image display and dynamic price calculation on product detail pages — specifically the field name corrections and the image URL resolution from Medusa v2 response shape. |
| **Problemas que resuelve** | Product images weren't displaying because the image array field from Medusa v2 changed to `product.images[].url` (not `product.thumbnail`). Dynamic prices showed undefined because the pricing context wasn't passed correctly in the Astro SSR endpoint. |
| **Resultado esperado** | All product images load correctly using the `images` array from Medusa v2. Prices display based on the customer's active cart region, with correct wholesale/retail pricing based on customer group membership. |
| **Scripts Creados** | `migrate/migrate-product-images.ts` |

## Changes Made (2026-02-01)

### Endpoint: `GET /store/products/:id/with-prices`

**Fixed Issues:**
1. ✅ **Missing Images**: Now returns `thumbnail` and `images` array
2. ✅ **Dynamic Pricing**: Prices now change based on customer group (Wholesale/Retail)

---

## How It Works

### Price Selection Logic

The endpoint uses this priority:

1. **Customer Group Price** (if customer is authenticated and in a group)
2. **Default Price** (fallback for guest users or no group)

### SQL Strategy

```sql
COALESCE(
    -- Try customer group price first
    (SELECT amount FROM price WHERE price_list_id IN (
        SELECT id FROM price_list WHERE customer_group_id = ?
    )),
    -- Fall back to default price
    (SELECT amount FROM price WHERE price_list_id IS NULL)
)
```

---

## Usage Examples

### For Guest Users (Default Retail Price)

```javascript
const response = await fetch(
    `${BACKEND_URL}/store/products/${productId}/with-prices`,
    {
        headers: {
            'x-publishable-api-key': API_KEY
        }
    }
)

const { product } = await response.json()

// Returns:
{
    product: {
        id: "prod_xxx",
        title: "Example Product",
        thumbnail: "https://...",
        images: [
            { id: "img_1", url: "https://..." },
            { id: "img_2", url: "https://..." }
        ],
        variants: [
            {
                id: "variant_1",
                sku: "SKU-001",
                calculated_price: {
                    calculated_amount: 100.00,  // Retail price
                    currency_code: "usd"
                }
            }
        ]
    }
}
```

### For Authenticated Wholesale Customers

```javascript
const response = await fetch(
    `${BACKEND_URL}/store/products/${productId}/with-prices?customer_id=${customerId}`,
    {
        headers: {
            'x-publishable-api-key': API_KEY
        }
    }
)

const { product } = await response.json()

// Returns:
{
    product: {
        // ... same structure
        variants: [
            {
                id: "variant_1",
                sku: "SKU-001",
                calculated_price: {
                    calculated_amount: 75.00,  // Wholesale price (25% discount)
                    currency_code: "usd"
                }
            }
        ]
    },
    _debug: {
        customer_group_id: "cusgroup_xxx",
        pricing_context: "customer_group"
    }
}
```

---

## Testing

### Test 1: Guest User (Should see Retail prices)

```bash
curl -H "x-publishable-api-key: pk_xxx" \
  "http://localhost:9000/store/products/prod_xxx/with-prices"
```

**Expected**: `calculated_amount` = Retail price

### Test 2: Wholesale Customer

```bash
curl -H "x-publishable-api-key: pk_xxx" \
  "http://localhost:9000/store/products/prod_xxx/with-prices?customer_id=cus_xxx"
```

**Expected**: `calculated_amount` = Wholesale price (lower than retail)

### Test 3: Images Present

```bash
curl -H "x-publishable-api-key: pk_xxx" \
  "http://localhost:9000/store/products/prod_xxx/with-prices"
```

**Expected**: Response includes `thumbnail` and `images` array

---

## Price Structure Reference

### Retail (Default)
- Standard price for guest users
- Stored in `price` table with `price_list_id = NULL`

### Wholesale
- Discounted price for business customers
- Stored in `price` table linked to price_list with `customer_group_id = "cusgroup_01KFTSDZQWYBC4523HJ38DZVE7"`
- Typically 20-30% lower than retail

---

## Migration Notes

If you were using the old endpoint, the response structure is the same **EXCEPT**:

- ✅ Now includes `thumbnail`
- ✅ Now includes `images[]`
- ✅ Prices are now customer-group aware

**No breaking changes** - just additions.

---

## Database Schema Reference

```
product_variant
  ├─> product_variant_price_set (junction)
       └─> price_set
            └─> price (multiple rows)
                 ├─ WHERE price_list_id IS NULL → Retail (default)
                 └─ WHERE price_list_id IN (price_list with customer_group) → Wholesale
```

---

**Author**: Backend Team  
**Date**: 2026-02-01  
**Related**: GETTING_PRODUCT_PRICES.md
