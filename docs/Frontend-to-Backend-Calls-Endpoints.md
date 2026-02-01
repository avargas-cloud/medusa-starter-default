# Frontend-to-Backend API Calls

**Complete Reference** | Tested & Verified | Medusa v2 + Custom Modifications  
**Last Updated:** 2026-01-31

---

## Table of Contents

1. [Authentication & Setup](#authentication--setup)
2. [Store API - Products](#store-api---products)
3. [Store API - Categories & Filters](#store-api---categories--filters)
4. [Store API - Cart & Checkout](#store-api---cart--checkout)
5. [Store API - Customer & Auth](#store-api---customer--auth)
6. [Store API - Orders](#store-api---orders)
7. [Admin API - Reference](#admin-api---reference)
8. [Real Examples & Testing](#real-examples--testing)

---

## Authentication & Setup

### Required Headers

**All Store API requests:**
```typescript
headers: {
  'x-publishable-api-key': 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3',
  'Content-Type': 'application/json'
}
```

**Authenticated requests (customer logged in):**
```typescript
headers: {
  'x-publishable-api-key': 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3',
  'Content-Type': 'application/json'
},
credentials: 'include'  // ← CRITICAL for session cookies
```

### Base URLs

- **Local:** `http://localhost:9000`
- **Production:** `https://medusa-starter-default-production-b69e.up.railway.app`

---

## Store API - Products

### 1. `GET /store/products` - List Products

**Purpose:** Fetch products with attributes, variants, and prices (all in one call)

**Query Parameters:**
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `limit` | number | Items per page (default: 20) | `20` |
| `offset` | number | Skip items (pagination) | `0` |
| `category_id` | string | Filter by category | `pcat_01XXX` |
| `handle` | string | Get specific product by slug | `led-strip-65ft` |
| `q` | string | Search query | `LED strip` |

**✅ Tested Response:**
```json
{
  "products": [
    {
      "id": "product_01KGAX7RCS2MQPQDDMV0S2CJ6C",
      "title": "100W Waterproof Meanwell Power Supply, Plastic, 24VDC",
      "handle": "100w-waterproof-meanwell-power-supply-plastic-24vdc",
      "description": "UL Recognized, 24VDC Output, IP67 Waterproof  Metal Case",
      "thumbnail": "https://...",
      "status": "published",
      "metadata": {
        "primary_category_id": "pcat_01XXX",
        "long_description": "<p>Detailed HTML description...</p>",
        "category": "Power Supplies"
      },
      "variants": [
        {
          "id": "variant_01XXX",
          "title": "100W",
          "sku": "ESP24V100WP1040",
          "inventory_quantity": 10,
          "options": [
            {
              "option_id": "opt_01XXX",
              "value": "100W"
            }
          ]
        }
      ],
      "attributes": [
        {
          "handle": "power-consumption",
          "label": "Power Consumption",
          "value": "100W"
        },
        {
          "handle": "connection",
          "label": "Connection",
          "value": "Bare Wires"
        },
        {
          "handle": "input-voltage",
          "label": "Input Voltage",
          "value": "90-264VAC"
        }
        // ... 17 total attributes
      ],
      "price": {
        "amount": 68.50,
        "currency_code": "usd"
      }
      // OR if variants have different prices:
      "price_range": {
        "min": { "amount": 65.00, "currency_code": "usd" },
        "max": { "amount": 75.00, "currency_code": "usd" }
      }
    }
  ]
}
```

**Custom Features:**
- ✅ `attributes` field automatically injected (batch-fetched, no N+1)
- ✅ `price` or `price_range` calculated from variants
- ✅ Prices in dollars (not cents)
- ✅ `handle` filter support for SEO-friendly URLs

**Usage Examples:**

```typescript
// Get all products (paginated)
GET /store/products?limit=20&offset=0

// Get products in specific category
GET /store/products?category_id=pcat_01KGAD1KQXDWJEP7HE92G5FCS4

// Get single product by handle (SEO-friendly)
GET /store/products?handle=100w-waterproof-meanwell-power-supply-plastic-24vdc

// Search products
GET /store/products?q=LED+strip

// Page 2 of results
GET /store/products?limit=20&offset=20
```

---

### 2. `GET /store/products/:id` - Get Single Product

**Purpose:** Fetch detailed product information by ID

**Path Parameter:**
- `:id` - Product ID (e.g., `product_01KGAX7RCS2MQPQDDMV0S2CJ6C`)

**Response:** Same structure as list endpoint (single product object)

**Usage:**
```typescript
GET /store/products/product_01KGAX7RCS2MQPQDDMV0S2CJ6C
```

**Note:** For SEO-friendly URLs, use `/store/products?handle=slug` instead.

---

### 3. `GET /store/products/:id/breadcrumbs` - Get Product Breadcrumbs

**Purpose:** Get category breadcrumb trail for product

**✅ Tested Response:**
```json
{
  "product": {
    "id": "product_01XXX",
    "title": "Product Name",
    // ... full product object
  },
  "main_category_breadcrumbs": [
    {
      "id": "pcat_ceiling-lights",
      "name": "Ceiling Lights",
      "handle": "ceiling-lights"
    },
    {
      "id": "pcat_flush-mount",
      "name": "Flush Mount Fixtures",
      "handle": "flush-mount-fixtures-ceiling-lights"
    },
    {
      "id": "pcat_square-units",
      "name": "Square Units",
      "handle": "square-units-flush-mount-fixtures-ceiling-lights"
    }
  ]
}
```

**Custom Logic:**
1. Uses `product.metadata.primary_category_id` if set (can be assigned in Admin UI)
2. Falls back to first category if no primary category
3. Recursively builds breadcrumb trail from category → root

**Frontend Usage:**
```tsx
const res = await fetch(`/store/products/${productId}/breadcrumbs`)
const { product, main_category_breadcrumbs } = await res.json()

// Render breadcrumbs
<nav>
  <a href="/">Home</a>
  {main_category_breadcrumbs?.map(crumb => (
    <span key={crumb.id}>
      {' > '}
      <a href={`/categories/${crumb.handle}`}>{crumb.name}</a>
    </span>
  ))}
  {' > '}
  <span>{product.title}</span>
</nav>
```

---

### 4. `GET /store/products/:id/with-prices` - Get Product with Calculated Prices ⭐ CUSTOM

**Purpose:** Fetch single product with calculated prices per variant (optimized for product detail pages)

**Path Parameter:**
- `:id` - Product ID (e.g., `product_01KGAX7RCXVXJVQ8QVHD7W0T54`)

**✅ Tested Response:**
```json
{
  "product": {
    "id": "product_01KGAX7RCXVXJVQ8QVHD7W0T54",
    "title": "adorne® Netatmo Smart Gateway",
    "handle": "adorne-netatmo-smart-gateway",
    "description": "Smart home gateway for adorne system",
    "thumbnail": "https://bucket-production.up.railway.app/medusa-media/product-...",
    "images": [
      {
        "id": "img_01XXX",
        "url": "https://bucket-production.up.railway.app/medusa-media/product-...",
        "metadata": null,
        "rank": 0
      },
      {
        "id": "img_02XXX",
        "url": "https://...",
        "metadata": null,
        "rank": 1
      }
      // ... 4 total images
    ],
    "variants": [
      {
        "id": "variant_01XXX",
        "title": "Default",
        "sku": "ADTH703GW4",
        "inventory_quantity": 5,
        "calculated_price": {
          "calculated_amount": 179,
          "currency_code": "usd"
        }
      }
    ],
    "options": [...]
  }
}
```

**Custom Features:**
- ✅ **Explicit image fields** - Uses `images.id`, `images.url`, `images.metadata`, `images.rank` instead of wildcard
- ✅ **Spread operator pattern** - Immutable object construction to preserve all fields
- ✅ **Calculated prices** - Each variant includes `calculated_price` with amount in dollars
- ✅ **Full product data** - Thumbnail, images, variants, and options included

**Implementation Notes:**
This endpoint was specifically designed to solve the "images not loading" issue when adding dynamic pricing. The solution uses:

1. **Explicit image fields** instead of `images.*` wildcard (Medusa v2 quirk)
2. **Spread operator pattern** to avoid object mutation:
   ```typescript
   const productResponse = {
       ...originalProduct,        // Preserves all fields
       variants: variantsWithPrices  // Only overwrites variants
   }
   ```

**Usage:**
```typescript
// Get product with prices
const response = await fetch(
  `/store/products/product_01KGAX7RCXVXJVQ8QVHD7W0T54/with-prices`,
  {
    headers: {
      'x-publishable-api-key': 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3'
    }
  }
)

const { product } = await response.json()

// Display product
console.log(product.title)                    // "adorne® Netatmo Smart Gateway"
console.log(product.thumbnail)                // Image URL
console.log(product.images.length)            // 4
console.log(product.variants[0].calculated_price.calculated_amount)  // 179
```

**Use Cases:**
- Product detail pages needing images + prices
- Cart preview with product images
- Quick-view modals with pricing
- Any component needing full product data in one call

---

## Store API - Categories & Filters

### 5. `GET /store/product-categories` - List Categories

**Purpose:** Fetch category tree

**Query Parameters:**
- `include_descendants_tree` (boolean): Include nested categories
- `fields` (string): Additional fields to return

**Response:**
```json
{
  "product_categories": [
    {
      "id": "pcat_01XXX",
      "name": "LED Strips",
      "handle": "led-strips",
      "parent_category_id": null,
      "category_children": [
        {
          "id": "pcat_02XXX",
          "name": "Single Color",
          "handle": "single-color"
        }
      ],
      "metadata": {
        "is_manually_sorted": false
      }
    }
  ]
}
```

---

### 6. `GET /store/product-categories/:id` - Get Category

**Purpose:** Get single category details

**Response:** Single category object (same structure as list)

---

### 7. `GET /store/categories/:id/filters` ⭐ CUSTOM

**Purpose:** Get available filters for category with **accurate product counts**

**✅ Tested Response:**
```json
{
  "filters": [
    {
      "id": "color-options",
      "name": "color-options",  // ← Use this to match product attributes
      "label": "Color Options",
      "values": [
        {
          "value": "3000K",
          "label": "3000K",
          "count": 8  // ← Accurate count (fixed via pagination: 1000)
        },
        {
          "value": "4000K",
          "label": "4000K",
          "count": 5
        },
        {
          "value": "6000K",
          "label": "6000K",
          "count": 12
        }
      ]
    },
    {
      "id": "length",
      "name": "length",
      "label": "Length",
      "values": [
        {
          "value": "16.4ft",
          "label": "16.4ft",
          "count": 3
        },
        {
          "value": "32.8ft",
          "label": "32.8ft",
          "count": 5
        }
      ]
    }
  ]
}
```

**Custom Features:**
- ✅ **Accurate counts** (fetches up to 1000 products from category)
- ✅ **Inherited filters** from parent categories
- ✅ `filter.name` = attribute handle (for matching with `product.attributes[].handle`)

**Frontend Filtering Logic:**
```typescript
// 1. Get category filters
const { filters } = await fetch(`/store/categories/${categoryId}/filters`)
  .then(r => r.json())

// 2. Get products in category
const { products } = await fetch(`/store/products?category_id=${categoryId}`)
  .then(r => r.json())

// 3. Client-side filter matching
const selectedFilter = { name: 'color-options', value: '4000K' }

const filtered = products.filter(product => 
  product.attributes?.some(attr => 
    attr.handle === selectedFilter.name && 
    attr.value === selectedFilter.value
  )
)
```

---

### 8. `GET /store/categories/:id/products-with-filters` ⭐ NEW COMBINED ENDPOINT

**Purpose:** Fetch **paginated products + dynamic filters** in a **single request**, guaranteeing 100% consistency between products and filter counts.

**Why Use This:**
- ✅ **Data Consistency** - Same query powers both products AND filters  
- ✅ **Fewer Network Requests** - One call instead of two  
- ✅ **Accurate Filter Counts** - Counts reflect exact products in current view  
- ✅ **Respects Category Settings** - Honors `include_descendants_tree` metadata

**Query Parameters:**
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `limit` | number | Products per page (default: 20) | `20` |
| `offset` | number | Skip items (pagination) | `0` |

**✅ Tested Response (LED Strips - 30 published products):**
```json
{
  "category": {
    "id": "pcat_01KGAD1KQXDWJEP7HE92G5FCS4",
    "name": "LED Strips",
    "handle": "led-strips",
    "parent_category_id": null,
    "include_descendants_tree": true
  },
  "products": [
    {
      "id": "product_01KGAX7RCT3S44GA70WHKMAPK3",
      "title": "18/2 AWG Stranded Wire",
      "status": "published",
      "attributes": [
        { "handle": "color-options", "label": "Color Options", "value": "3000K" },
        { "handle": "length", "label": "Length", "value": "16.4ft" }
      ],
      "price": { "amount": 32.00, "currency_code": "usd" }
    }
  ],
  "filters": [
    {
      "id": "color-options",
      "attribute": "color-options",
      "name": "Color Options",
      "type": "checkbox",
      "options": [
        { "option": "3000K", "count": 8 },
        { "option": "4000K", "count": 5 }
      ]
    }
  ],
  "pagination": {
    "total": 30,
    "limit": 20,
    "offset": 0,
    "has_more": true
  }
}
```

**Custom Features:**
- ✅ `attributes` + `calculated_price` auto-injected
- ✅ Filter counts from ALL products (not just current page)
- ✅ Respects `category.metadata.include_descendants_tree`
- ✅ **Only `status: "published"` products** (drafts excluded)

**Usage:**
```typescript
GET /store/categories/pcat_01KGAD1KQXDWJEP7HE92G5FCS4/products-with-filters?limit=20
```

**⚙️ Category Configuration: `include_descendants_tree` Metadata**

Each category can control whether to include products from child categories using the `include_descendants_tree` metadata field.

**Admin UI Widget:**
- Location: Category detail pages
- Widget name: "Include Subcategory Products"
- Options: Yes / No toggle
- Default: **Yes** (true) for all categories

**Setting via Admin UI:**
1. Navigate to category detail page in Admin
2. Scroll to "Include Subcategory Products" widget
3. Toggle Yes/No
4. Page auto-reloads with new setting

**Effect on API Response:**

```typescript
// Category with include_descendants_tree: true
{
  "category": {
    "include_descendants_tree": true
  },
  "pagination": {
    "total": 30  // ← Includes products from 18 child categories
  }
}

// Category with include_descendants_tree: false  
{
  "category": {
    "include_descendants_tree": false
  },
  "pagination": {
    "total": 10  // ← Only products directly in this category
  }
}
```

**Implementation Details:**
- Stored in `category.metadata.include_descendants_tree`
- Defaults to `true` if not explicitly set
- Recursive search (max depth: 5 levels) when enabled
- All 126 existing categories initialized to `true`

---

### 9. `GET /store/categories/:id/sorting` ⭐ CUSTOM

**Purpose:** Get manually sorted product list for category

**Response:**
```json
{
  "is_manually_sorted": true,
  "sorted_products": [
    {
      "product_id": "product_01XXX",
      "sort_order": 1
    },
    {
      "product_id": "product_02XXX",
      "sort_order": 2
    }
  ]
}
```

**Usage:**
```typescript
const { is_manually_sorted, sorted_products } = await fetch(
  `/store/categories/${categoryId}/sorting`
).then(r => r.json())

if (is_manually_sorted) {
  // Sort products by sort_order
  products.sort((a, b) => {
    const aOrder = sorted_products.find(sp => sp.product_id === a.id)?.sort_order ?? 999
    const bOrder = sorted_products.find(sp => sp.product_id === b.id)?.sort_order ?? 999
    return aOrder - bOrder
  })
}
```

---

## Store API - Cart & Checkout

### 8. `POST /store/carts` - Create Cart

**Purpose:** Initialize shopping cart

**Request Body:**
```json
{
  "region_id": "reg_01XXX"  // Optional
}
```

**Response:**
```json
{
  "cart": {
    "id": "cart_01XXX",
    "email": null,
    "region_id": "reg_01XXX",
    "items": [],
    "subtotal": 0,
    "total": 0,
    "currency_code": "usd"
  }
}
```

**💡 Tip:** Save `cart.id` to localStorage for persistence across sessions.

---

### 9. `POST /store/carts/:id/line-items` - Add to Cart

**Purpose:** Add product variant to cart

**Request Body:**
```json
{
  "variant_id": "variant_01XXX",
  "quantity": 2
}
```

**Response:** Updated cart object with new item

---

### 10. `GET /store/carts/:id` - Get Cart

**Purpose:** Fetch current cart state

**Response:**
```json
{
  "cart": {
    "id": "cart_01XXX",
    "items": [
      {
        "id": "item_01XXX",
        "title": "Product Name",
        "variant": {
          "id": "variant_01XXX",
          "title": "4000K",
          "sku": "SKU123"
        },
        "quantity": 2,
        "unit_price": 68.50,
        "total": 137.00
      }
    ],
    "subtotal": 137.00,
    "tax_total": 0,
    "total": 137.00
  }
}
```

---

### 11. `POST /store/carts/:id/line-items/:line_id` - Update Cart Item

**Purpose:** Update quantity

**Request Body:**
```json
{
  "quantity": 3
}
```

---

### 12. `DELETE /store/carts/:id/line-items/:line_id` - Remove from Cart

**Purpose:** Remove item

---

### 13. `POST /store/carts/:id/shipping-address` - Add Shipping Address

**Request Body:**
```json
{
  "first_name": "John",
  "last_name": "Doe",
  "address_1": "123 Main St",
  "city": "Miami",
  "country_code": "us",
  "state": "FL",
  "postal_code": "33101",
  "phone": "+1234567890"
}
```

---

### 14. `POST /store/carts/:id/complete` - Complete Order

**Purpose:** Finalize cart and create order

**Response:**
```json
{
  "type": "order",
  "data": {
    "id": "order_01XXX",
    "display_id": 1001,
    "email": "customer@example.com",
    "status": "pending",
    "items": [...],
    "total": 137.00
  }
}
```

---

## Store API - Customer & Auth

### 15. `POST /store/auth` - Customer Login (Email/Password)

**Request Body:**
```json
{
  "email": "customer@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "customer": {
    "id": "cus_01XXX",
    "email": "customer@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "has_account": true
  }
}
```

**💡 Cookie automatically set for future authenticated requests**

---

### 16. `GET /store/auth/google` - Google OAuth Login

**Purpose:** Redirect to Google OAuth flow

**Flow:**
1. User clicks "Sign in with Google"
2. Frontend redirects to `/store/auth/google`
3. User authenticates with Google
4. Backend creates/updates customer
5. Redirects to `http://localhost:3000/account` with session cookie

**Usage:**
```typescript
// Login button
<button onClick={() => window.location.href = '/store/auth/google'}>
  Sign in with Google
</button>
```

---

### 17. `GET /store/customers/me` - Get Current Customer

**Requires:** `credentials: 'include'`

**Response:**
```json
{
  "customer": {
    "id": "cus_01XXX",
    "email": "customer@example.com",
    "first_name": "John",
    "last_name": "Doe",
    "phone": "+1234567890",
    "metadata": {}
  }
}
```

---

### 18. `POST /store/customers/me` - Update Customer

**Request Body:**
```json
{
  "first_name": "Jane",
  "last_name": "Smith",
  "phone": "+1987654321"
}
```

---

### 19. `DELETE /store/auth` - Logout

**Response:** Session cookie cleared

---

## Store API - Orders

### 20. `GET /store/customers/me/orders` - Get Customer Orders

**Requires:** Authenticated customer

**Response:**
```json
{
  "orders": [
    {
      "id": "order_01XXX",
      "display_id": 1001,
      "status": "completed",
      "created_at": "2026-01-31T20:00:00Z",
      "total": 137.00,
      "items": [...]
    }
  ]
}
```

---

### 21. `GET /store/orders/:id` - Get Order Details

**Purpose:** Fetch specific order

---

## Admin API - Reference

### Product Management

```typescript
// List products (admin)
GET /admin/products
Authorization: Bearer {admin_token}

// Update product
POST /admin/products/:id
Body: { title, description, ... }

// Delete product
DELETE /admin/products/:id
```

### Custom Admin Endpoints

```typescript
// Sync category attributes
POST /admin/product-categories/:id/sync-attributes

// Sync category sorting
POST /admin/product-categories/:id/sync-sorting

// Sync product to MeiliSearch
POST /admin/sync-product-meilisearch/:id

// Search customers (MeiliSearch)
GET /admin/search/customers/sync

// Search inventory (MeiliSearch)
GET /admin/search/inventory/query
```

---

## Real Examples & Testing

### Example 1: Product Listing Page

```typescript
async function getProductsWithFilters(categoryId: string) {
  const API = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL
  const KEY = process.env.NEXT_PUBLIC_PUBLISHABLE_API_KEY
  
  // 1. Get category filters
  const filtersRes = await fetch(
    `${API}/store/categories/${categoryId}/filters`,
    { headers: { 'x-publishable-api-key': KEY } }
  )
  const { filters } = await filtersRes.json()
  
  // 2. Get products
  const productsRes = await fetch(
    `${API}/store/products?category_id=${categoryId}&limit=20`,
   { headers: { 'x-publishable-api-key': KEY } }
  )
  const { products } = await productsRes.json()
  
  return { products, filters }
}
```

### Example 2: Product Detail Page

```typescript
async function getProductDetails(handle: string) {
  const API = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL
  const KEY = process.env.NEXT_PUBLIC_PUBLISHABLE_API_KEY
  
  // Get product with breadcrumbs
  const res = await fetch(
    `${API}/store/products?handle=${handle}`,
    { headers: { 'x-publishable-api-key': KEY } }
  )
  const { products } = await res.json()
  const product = products[0]
  
  // Get breadcrumbs
  const breadcrumbsRes = await fetch(
    `${API}/store/products/${product.id}/breadcrumbs`,
    { headers: { 'x-publishable-api-key': KEY } }
  )
  const { main_category_breadcrumbs } = await breadcrumbsRes.json()
  
  return { product, breadcrumbs: main_category_breadcrumbs }
}
```

### Example 3: Add to Cart Flow

```typescript
async function addToCart(variantId: string, quantity: number) {
  const API = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL
  const KEY = process.env.NEXT_PUBLIC_PUBLISHABLE_API_KEY
  
  // Get or create cart
  let cartId = localStorage.getItem('cart_id')
  
  if (!cartId) {
    const res = await fetch(`${API}/store/carts`, {
      method: 'POST',
      headers: {
        'x-publishable-api-key': KEY,
        'Content-Type': 'application/json'
      }
    })
    const { cart } = await res.json()
    cartId = cart.id
    localStorage.setItem('cart_id', cartId)
  }
  
  // Add item
  const res = await fetch(`${API}/store/carts/${cartId}/line-items`, {
    method: 'POST',
    headers: {
      'x-publishable-api-key': KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ variant_id: variantId, quantity })
  })
  
  return res.json()
}
```

### Testing Script

```bash
# Save as test_api.sh
API="http://localhost:9000"
KEY="pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3"

# Test products list
curl -s "$API/store/products?limit=2" \
  -H "x-publishable-api-key: $KEY" | jq '.products | length'

# Test product by handle
curl -s "$API/store/products?handle=100w-waterproof-meanwell-power-supply-plastic-24vdc" \
  -H "x-publishable-api-key: $KEY" | jq '.products[0].title'

# Test category filters
curl -s "$API/store/categories/pcat_01JHJG30GNRTZ4NKT3YHRQGQED/filters" \
  -H "x-publishable-api-key: $KEY" | jq '.filters | length'
```

---

## Key Differences from Standard Medusa

### Custom Features Added

1. ✅ **Product Attributes** - `product.attributes[]` auto-injected via batch SQL
2. ✅ **Price Calculation** - `product.price` or `product.price_range` from variants
3. ✅ **Handle Filter** - Query directly by handle: `?handle=product-slug`
4. ✅ **Category Filters** - Accurate counts with inheritance
5. ✅ **Breadcrumbs** - Automatic category trail generation
6. ✅ **Manual Sorting** - Per-category custom product order
7. ✅ **Google OAuth** - `/store/auth/google` redirect flow

### Important Notes

1. **Prices are in dollars** (not cents like Medusa v1)
   ```json
   "price": { "amount": 68.50 }  // ← $68.50, not 6850 cents
   ```

2. **Attributes vs Options:**
   - `product.attributes` = Filterable properties (Color Options, Power, etc.)
   - `product.variants[].options` = Variant-specific values

3. **Filter Matching:**
   - Use `filter.name` (attribute handle) to match `product.attributes[].handle`
   - Use `filter.values[].value` to match `product.attributes[].value`

4. **Performance:**
   - Products endpoint: ~200-300ms for 20 products with attributes
   - Attributes batch-fetched (single SQL query, no N+1)
   - Pagination limited to 1000 products for accurate filter counts

---

## Common Patterns

### Pagination
```typescript
// Page 1
GET /store/products?limit=20&offset=0

// Page 2
GET /store/products?limit=20&offset=20
```

### Filter + Search
```typescript
GET /store/products?category_id=pcat_01XXX&q=LED
```

### Authenticated Requests
```typescript
fetch(url, {
  headers: { 'x-publishable-api-key': KEY },
  credentials: 'include'  // ← For session cookies
})
```

---

**Questions?** Check `/docs/FRONTEND_INTEGRATION_GUIDE.md` for more details.
