# Debug Scripts

Quick scripts for verifying product attributes and category filters.

## Quick Start

**Step 1: Find Product/Category ID**
```bash
# List all products (or search)
npx tsx scripts/debug/list-products.ts [search-term]

# List all categories (or search)
npx tsx scripts/debug/list-categories.ts [search-term]
```

**Step 2: View Details**
```bash
# View product attributes
npx tsx scripts/debug/view-product-attributes.ts [product-id]

# View category filters
npx tsx scripts/debug/view-category-filters.ts [category-id]
```

---

## 1. List Products

Find product IDs by searching:

```bash
npx tsx scripts/debug/list-products.ts "LED"
```

**Output:**
```
📦 Products matching "LED" (showing 10 of 247):
────────────────────────────────────────────────────────────────────────────────

UL FREECUT COB LED Strip Single Color, Bright Output
  ID: prod_01H8X9Z...
  Handle: ul-freecut-cob-led-strip-single-color-bright-output
  Status: published
  Power: 6W

65FT UL SMD2835 LED Strip 2400 Single Color Chips
  ID: prod_01H8X9A...
  Handle: 65ft-ul-smd2835-led-strip-2400-single-color-chips
  Status: published
  Power: 96W
...
```

---

## 2. List Categories

Find category IDs:

```bash
npx tsx scripts/debug/list-categories.ts "LED"
```

**Output:**
```
📂 Categories matching "LED" (showing 5 of 42):
────────────────────────────────────────────────────────────────────────────────

LED Strips
  ID: pcat_01KFKKM...
  Handle: led-strips

  White LED Strips
    ID: pcat_01KFKKN...
    Handle: led-strips-white
    Filters: 15 configured
...
```

---

## 3. View Product Attributes

See all attributes for a specific product:

```bash
npx tsx scripts/debug/view-product-attributes.ts prod_01H8X9Z...
```

**Output:**
```
📦 Product: UL FREECUT COB LED Strip Single Color, Bright Output
   ID: prod_01H8X9Z...
   Handle: ul-freecut-cob-led-strip-single-color-bright-output
   Status: published

🏷️  Attributes (36):
────────────────────────────────────────────────────────────────────────────────

Color Temperature (color-temperature)
  ID: 01KFK5SM3EDB6V3NQXGKQEZ8QM
  Filter Type: checkbox
  Value: 3000K

Power Consumption (power-consumption)
  ID: 01KFK5WE9Q1AB9QR7GFVS5MAD7
  Filter Type: checkbox
  Value: 6W
...
```

---

## 4. View Category Filters

See all filters in a category's metadata:

```bash
npx tsx scripts/debug/view-category-filters.ts pcat_01KFKKN...
```

**Output:**
```
📂 Category: White LED Strips
   ID: pcat_01KFKKN...
   Handle: led-strips-white

🔎 Filters (15):
────────────────────────────────────────────────────────────────────────────────

Power Consumption (power-consumption)
  Filter Type: checkbox
  Values (2):
    - 6W (1 products)
    - 96W (1 products)
...
```

---

## Troubleshooting

### "Category/Product not found"

Make sure you're using the **ID** (like `prod_01H8X...` or `pcat_01KFK...`), not the handle or title.

Use the list scripts to find the correct ID first.

### Filters are empty

If a category shows no filters, the metadata hasn't been synced yet. Run:

```bash
curl -X POST http://localhost:9000/admin/product-categories/[category-id]/sync-attributes \
  -H "Cookie: connect.sid=YOUR_SESSION"
```

Or save product attributes via the admin UI - filters will auto-sync.

### Script returns 401

Some scripts require authentication. Use curl with your session cookie:

```bash
curl -H 'Cookie: connect.sid=YOUR_SESSION' \
  http://localhost:9000/admin/products/[product-id]
```

---

## Summary

| Script | Purpose |
|--------|---------|
| `list-products.ts` | Find product IDs by searching |
| `list-categories.ts` | Find category IDs |
| `view-product-attributes.ts` | See all attributes for a product |
| `view-category-filters.ts` | See filters configured for a category |

