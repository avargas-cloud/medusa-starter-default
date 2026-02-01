# Frontend API Reference

Complete reference for all backend API calls from the frontend. All endpoints use the Store API with `x-publishable-api-key` header.

## Authentication Header

All requests require:
```bash
x-publishable-api-key: pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3
```

---

## Products Endpoints

### 1. GET `/store/products` - List Products

**Purpose:** Fetch products with attributes, variants, and prices.

**Query Parameters:**
- `limit` (number): Items per page (default: 20)
- `offset` (number): Skip items (default: 0)
- `category_id` (string): Filter by category
- `handle` (string): Get specific product by handle
- `q` (string): Search query

**Response Structure:**
```json
{
  "products": [
    {
      "id": "product_01XXX",
      "title": "Product Name",
      "handle": "product-slug",
      "description": "Product description",
      "thumbnail": "https://...",
      "status": "published",
      "metadata": {},
      "variants": [
        {
          "id": "variant_01XXX",
          "title": "4000K",
          "sku": "SKU123",
          "inventory_quantity": 10
        }
      ],
      "attributes": [
        {
          "handle": "color-options",
          "label": "Color Options",
          "value": "4000K"
        },
        {
          "handle": "length",
          "label": "Length",
          "value": "65.5ft"
        }
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

**Examples:**

```bash
# Get all products (paginated)
GET /store/products?limit=20&offset=0

# Get products in category
GET /store/products?category_id=pcat_01XXX

# Get single product by handle
GET /store/products?handle=65ft-ul-smd2835-led-strip

# Search products
GET /store/products?q=LED+strip
```

---

### 2. GET `/store/products/:id` - Get Single Product

**Purpose:** Fetch detailed product information by ID.

**Response:** Same structure as list endpoint, but single product object.

**Example:**
```bash
GET /store/products/product_01KFXXX
```

---

## Categories Endpoints

### 3. GET `/store/product-categories` - List Categories

**Purpose:** Fetch category tree.

**Query Parameters:**
- `fields` (string): Additional fields to include
- `include_descendants_tree` (boolean): Include nested categories

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
      ]
    }
  ]
}
```

**Example:**
```bash
GET /store/product-categories?include_descendants_tree=true
```

---

### 4. GET `/store/product-categories/:id` - Get Category

**Purpose:** Get single category details.

**Response:** Single category object with same structure as list.

---

### 5. GET `/store/categories/:id/filters` - Get Category Filters

**Purpose:** Fetch available filters for a category with accurate product counts.

**Response:**
```json
{
  "filters": [
    {
      "id": "color-options",
      "name": "color-options",
      "label": "Color Options",
      "values": [
        {
          "value": "3000K",
          "label": "3000K",
          "count": 8
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
        }
      ]
    }
  ]
}
```

**Usage Notes:**
- `filter.name` is the attribute handle (use this to match with product attributes)
- `count` reflects actual products in category with that attribute
- Filters inherit from parent categories

**Example:**
```bash
GET /store/categories/pcat_01XXX/filters
```

---

## Cart Endpoints

### 6. POST `/store/carts` - Create Cart

**Purpose:** Initialize new shopping cart.

**Request Body:**
```json
{
  "region_id": "reg_01XXX"
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
    "total": 0
  }
}
```

---

### 7. POST `/store/carts/:id/line-items` - Add to Cart

**Purpose:** Add product variant to cart.

**Request Body:**
```json
{
  "variant_id": "variant_01XXX",
  "quantity": 2
}
```

**Response:** Updated cart object with new item.

---

### 8. POST `/store/carts/:id/line-items/:line_id` - Update Cart Item

**Purpose:** Update quantity of cart item.

**Request Body:**
```json
{
  "quantity": 3
}
```

---

### 9. DELETE `/store/carts/:id/line-items/:line_id` - Remove from Cart

**Purpose:** Remove item from cart.

---

### 10. GET `/store/carts/:id` - Get Cart

**Purpose:** Fetch current cart state.

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

## Customer Endpoints

### 11. POST `/store/customers` - Register Customer

**Purpose:** Create new customer account.

**Request Body:**
```json
{
  "email": "customer@example.com",
  "password": "securepassword",
  "first_name": "John",
  "last_name": "Doe"
}
```

---

### 12. POST `/store/auth` - Customer Login

**Purpose:** Authenticate customer.

**Request Body:**
```json
{
  "email": "customer@example.com",
  "password": "securepassword"
}
```

**Response:**
```json
{
  "customer": {
    "id": "cus_01XXX",
    "email": "customer@example.com",
    "first_name": "John",
    "last_name": "Doe"
  }
}
```

---

### 13. GET `/store/customers/me` - Get Current Customer

**Purpose:** Fetch authenticated customer details.

**Requires:** Session cookie from login.

---

### 14. DELETE `/store/auth` - Customer Logout

**Purpose:** End customer session.

---

## Order Endpoints

### 15. POST `/store/carts/:id/complete` - Complete Order

**Purpose:** Finalize cart and create order.

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

### 16. GET `/store/customers/me/orders` - Get Customer Orders

**Purpose:** Fetch order history for authenticated customer.

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

### 17. GET `/store/orders/:id` - Get Order Details

**Purpose:** Fetch specific order by ID.

---

## Regions & Shipping

### 18. GET `/store/regions` - List Regions

**Purpose:** Get available regions for cart/checkout.

**Response:**
```json
{
  "regions": [
    {
      "id": "reg_01XXX",
      "name": "United States",
      "currency_code": "usd",
      "countries": [
        {
          "iso_2": "us",
          "name": "United States"
        }
      ]
    }
  ]
}
```

---

### 19. GET `/store/shipping-options/:cart_id` - Get Shipping Options

**Purpose:** Fetch available shipping methods for cart.

---

## Common Patterns

### Pagination
```javascript
// Page 1
GET /store/products?limit=20&offset=0

// Page 2
GET /store/products?limit=20&offset=20

// Page 3
GET /store/products?limit=20&offset=40
```

### Filtering Products by Category
```javascript
// 1. Get category ID from category list
GET /store/product-categories

// 2. Get filters for that category
GET /store/categories/{categoryId}/filters

// 3. Fetch products in category
GET /store/products?category_id={categoryId}

// 4. Client-side filter by attributes
// Match product.attributes[].handle to filter.name
// Match product.attributes[].value to filter.values[].value
```

### Product Detail Page
```javascript
// Option 1: By handle (SEO-friendly)
GET /store/products?handle=product-slug

// Option 2: By ID
GET /store/products/{productId}
```

### Cart Flow
```javascript
// 1. Create cart
POST /store/carts { region_id }

// 2. Add items
POST /store/carts/{cartId}/line-items { variant_id, quantity }

// 3. Update quantities
POST /store/carts/{cartId}/line-items/{lineId} { quantity }

// 4. Complete order
POST /store/carts/{cartId}/complete
```

---

## Error Handling

All endpoints may return errors:

**404 Not Found:**
```json
{
  "message": "Product not found",
  "type": "not_found"
}
```

**400 Bad Request:**
```json
{
  "message": "Invalid parameters",
  "type": "invalid_data"
}
```

**401 Unauthorized:**
```json
{
  "message": "Unauthorized",
  "type": "unauthorized"
}
```

---

## Frontend Implementation Example

```typescript
// API client setup
const API_BASE = 'https://your-domain.com'
const API_KEY = 'pk_519e7f66680...'

const headers = {
  'x-publishable-api-key': API_KEY,
  'Content-Type': 'application/json'
}

// Fetch products with attributes
async function getProducts(categoryId?: string) {
  const url = new URL(`${API_BASE}/store/products`)
  if (categoryId) url.searchParams.set('category_id', categoryId)
  
  const res = await fetch(url, { headers })
  return res.json()
}

// Get product by handle
async function getProductByHandle(handle: string) {
  const url = new URL(`${API_BASE}/store/products`)
  url.searchParams.set('handle', handle)
  
  const res = await fetch(url, { headers })
  const data = await res.json()
  return data.products[0] // Handle query returns array
}

// Get category filters
async function getCategoryFilters(categoryId: string) {
  const res = await fetch(
    `${API_BASE}/store/categories/${categoryId}/filters`,
    { headers }
  )
  return res.json()
}
```

---

## Notes

1. **Attributes vs Options:**
   - `product.attributes` = filterable properties (Color Options, Length, etc.)
   - `product.variants` = purchasable SKUs with their option values

2. **Price Handling:**
   - Prices are in dollars (not cents)
   - Single price: `product.price.amount`
   - Price range: `product.price_range.min.amount` to `product.price_range.max.amount`

3. **Filter Matching:**
   - Use `filter.name` (attribute handle) to match `product.attributes[].handle`
   - Use `filter.values[].value` to match `product.attributes[].value`

4. **Performance:**
   - Products endpoint includes all data needed (no N+1 queries)
   - Attributes batch-fetched for all products in one query
   - Typical response time: 200-300ms for 20 products
