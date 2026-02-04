# Category Breadcrumbs - Storefront Integration Guide

## ⚠️ IMPORTANT UPDATE (2026-02-04)

**This document has been updated.** The old implementation using product metadata is **deprecated**. 

**New implementation:** Breadcrumbs are now provided directly in the **Category API** response.

---

## 📋 Overview

Category breadcrumbs are now **automatically included** in the Medusa v2 Store API category endpoints. No extra API calls, no metadata parsing—just fetch the category and use the `breadcrumbs` array.

---

## 🔌 API Endpoints

### Option 1: Get Category by Handle (Recommended)

**Endpoint:**
```
GET /store/product-categories?handle=led-drivers
```

**Response:**
```json
{
  "product_categories": [{
    "id": "pcat_01KGAD1KQXVSAXPSQXXYH5YCV8",
    "name": "LED Drivers",
    "handle": "led-drivers",
    "description": "",
    "metadata": {
      "image": { "url": "https://..." },
      "filters": [...]
    },
    "breadcrumbs": [
      { "id": "pcat_...", "name": "BY CATEGORIES", "handle": "by-categories" },
      { "id": "pcat_...", "name": "LED Drivers", "handle": "led-drivers" }
    ],
    "category_children": [
      { "id": "pcat_...", "name": "DIMMABLE", "handle": "dimmable-power-supplies" },
      { "id": "pcat_...", "name": "WATERPROOF", "handle": "waterproof-power-supplies" }
    ]
  }]
}
```

### Option 2: Get Category by ID

**Endpoint:**
```
GET /store/product-categories/:id
```

**Response:** Same structure as above, but under `product_category` key.

---

## 💻 Frontend Integration

### Fetch Category Data

```typescript
// lib/medusa.ts
export async function getCategoryByHandle(handle: string) {
  const res = await fetch(
    `${process.env.MEDUSA_BACKEND_URL}/store/product-categories?handle=${handle}`,
    {
      headers: { 'x-publishable-api-key': process.env.MEDUSA_PUBLISHABLE_KEY! },
      next: { revalidate: 3600 }
    }
  )
  
  const { product_categories } = await res.json()
  return product_categories[0] // Has breadcrumbs + category_children
}
```

### Render Breadcrumbs Component

```tsx
// components/Breadcrumbs.tsx
interface BreadcrumbItem {
  id: string
  name: string
  handle: string
}

interface Props {
  items: BreadcrumbItem[]
}

export default function Breadcrumbs({ items }: Props) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex gap-2 text-sm">
        <li><a href="/">Home</a></li>
        {items.map((crumb, i) => (
          <li key={crumb.id}>
            <span>/</span>
            {i === items.length - 1 ? (
              <span className="font-semibold">{crumb.name}</span>
            ) : (
              <a href={`/category/${crumb.handle}`}>{crumb.name}</a>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
```

### Category Page Implementation

```tsx
// pages/category/[handle].tsx
import { getCategoryByHandle } from '@/lib/medusa'
import Breadcrumbs from '@/components/Breadcrumbs'

export default async function CategoryPage({ params }) {
  const category = await getCategoryByHandle(params.handle)

  return (
    <div>
      {/* Navigation */}
      <Breadcrumbs items={category.breadcrumbs} />

      {/* Category Header */}
      <h1>{category.name}</h1>
      {category.metadata?.image?.url && (
        <img src={category.metadata.image.url} alt={category.name} />
      )}

      {/* Subcategories */}
      {category.category_children.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          {category.category_children.map(sub => (
            <a key={sub.id} href={`/category/${sub.handle}`}>
              {sub.name}
            </a>
          ))}
        </div>
      )}

      {/* Products would go here */}
    </div>
  )
}
```

---

## 📦 What's Included

### ✅ Breadcrumbs
- Full trail from root category to current category
- Each breadcrumb has: `id`, `name`, `handle`
- Always present (even for root categories)

### ✅ Subcategories (`category_children`)
- Direct children of the current category
- Empty array `[]` if no subcategories
- Each child has: `id`, `name`, `handle`, `rank`

### ✅ Metadata
- Full category metadata including images and filters
- Access via `category.metadata.image.url`

---

## 🎯 Common Patterns

### SEO-Friendly Breadcrumbs with Schema.org

```tsx
const breadcrumbSchema = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": category.breadcrumbs.map((crumb, index) => ({
    "@type": "ListItem",
    "position": index + 1,
    "name": crumb.name,
    "item": `https://yoursite.com/category/${crumb.handle}`
  }))
}

<script type="application/ld+json">
  {JSON.stringify(breadcrumbSchema)}
</script>
```

### Conditional Subcategories Display

```tsx
{category.category_children.length > 0 && (
  <section>
    <h2>Browse by Subcategory</h2>
    <div className="grid">
      {category.category_children.map(sub => (
        <CategoryCard key={sub.id} category={sub} />
      ))}
    </div>
  </section>
)}
```

---

## ✅ Summary

**Single API call returns:**
- ✅ Category data (name, handle, description, metadata)
- ✅ Breadcrumbs trail (full navigation path)
- ✅ Subcategories (direct children)

**No extra requests needed!**

---

**Last Updated:** 2026-02-04  
**Version:** 2.0 (Category API)  
**Status:** ✅ Production Ready
