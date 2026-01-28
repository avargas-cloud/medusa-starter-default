# Inventory Advanced - Architecture Reference

**Version**: 2.1  
**Created**: January 2026  
**Last Updated**: January 27, 2026 (Sync Workflows + Search Proxy + Real-time Sorting)  
**Status**: ✅ Production Ready

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Backend Implementation](#backend-implementation)
4. [MeiliSearch Integration](#meilisearch-integration)
5. [Frontend Structure](#frontend-structure)
6. [Data Flow](#data-flow)
7. [Component Details](#component-details)
8. [Hooks & State Management](#hooks--state-management)
9. [Sidebar Integration](#sidebar-integration)
10. [Critical Decisions](#critical-decisions)
11. [Troubleshooting](#troubleshooting)

---

## Executive Summary

**Inventory Advanced** is a custom Admin UI page that replaces the native Medusa Inventory page with an enhanced version that displays **product prices, thumbnails, and real-time inventory data** (including Reserved quantity) in a unified, searchable interface.

### Key Features (v2.1 Update)

- ✅ **Real-time Blocking Sync**: Page load triggers a workflow that guarantees fresh data before display.
- ✅ **Search Proxy**: Backend route `/admin/search/inventory/query` to bypass CORS restrictions.
- ✅ **Interactive Sorting**: Fully sortable by **Reserved**, **Stock**, Price, SKU, and Title.
- ✅ **Complete Data Scope**: Syncs Thumbnail, SKU, Price, Stock, and Reserved data instantly.
- ✅ **MeiliSearch**: For instant search/filter/sort with typo tolerance.
- ✅ **Clean Sync Protocol**: Deleted products disappear immediately.

**Route**: `/app/inventory-advanced`  
**Hijacks**: Native `/app/inventory` route  
**Search Index**: `inventory` (MeiliSearch)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│               User clicks "Inventory" in sidebar         │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│         sidebar-hijacker.tsx (Global Widget)             │
│   Intercepts click → redirects to /inventory-advanced   │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│          /app/inventory-advanced/page.tsx                │
│                                                          │
│  ┌────────────────────────────────────────────────┐   │
│  │  useInventorySearch() Hook                      │   │
│  │  1. Triggers Sync via Workflow (Blocking)       │   │
│  │  2. Invalidates React Query Cache               │   │
│  │  3. Fetches fresh data via Search Proxy         │   │
│  └────────────────┬──────────────────────────────┘   │
│                   │                                     │
│  ┌────────────────▼──────────────────────────────┐   │
│  │  UI Components:                                 │   │
│  │  • InventoryHeader (Sorting/Filters)           │   │
│  │  • InventoryTable (Interactive Headers)        │   │
│  └─────────────────────────────────────────────────┘   │
└───────────┬─────────────────────────────┬──────────────┘
            │                             │
            ▼                             ▼
┌──────────────────────────┐    ┌──────────────────────────┐
│   MeiliSearch Instance   │    │   Sync Workflow          │
│  Index: "inventory"      │    │  (src/workflows/...)     │
│  Updated in Real-time    │    │  Fetches DB -> Updates   │
│  Sortable: Reserved/Stock│    │  Meili -> Returns TaskUID│
└──────────────────────────┘    └──────────────────────────┘
```

---

## Backend Implementation

### Sync Workflow (v2.1)

**File**: `/src/workflows/sync-inventory.ts`

Instead of a simple API route, we now use a **Medusa Workflow** to handle synchronization. This ensures robust, error-tolerant execution and allows for blocking behavior.

**The Workflow Steps:**
1.  **Resolve Query Graph**: Fetches `product_variant` with `inventory_items`, `prices`, `product`, and `categories`.
2.  **Transform Logic**: Flattens the complex relationship graph into a simple, search-ready object.
    *   **Crucial Fields Synced**: `totalReserved`, `totalStock`, `price`, `sku`, `thumbnail`.
3.  **Update Settings**: Ensures `totalReserved` and `totalStock` are `sortableAttributes`.
4.  **Atomic Swap**: Uses `deleteAllDocuments` followed by `addDocuments` to ensure no stale data.
5.  **Blocking Wait**: Calls `task.waitForTask(uid)` to **block execution** until MeiliSearch confirms indexing is complete.

### Search Proxy (CORS Solution)

**File**: `/src/api/admin/search/inventory/query/route.ts`

**Problem**: Browsers often block direct requests to MeiliSearch (port 7700) due to CORS or Mixed Content (HTTP vs HTTPS).
**Solution**: A backend proxy route that forwards search queries to MeiliSearch using server-side credentials.

```typescript
// Frontend calls: POST /admin/search/inventory/query
// Backend:
const client = new MeiliSearch({ apiKey: MASTER_KEY })
const results = await index.search(body.q, body.options)
res.json(results)
```

---

## MeiliSearch Integration

### Index Configuration

The workflow ensures the index is configured with these attributes every time it runs:

```javascript
{
    filterableAttributes: [
        "category_handles",
        "status",
        "id",
        "sku"
    ],
    sortableAttributes: [
        "title",
        "sku",
        "totalStock",    // En Stock
        "price",         // Price
        "totalReserved"  // Reserved Quantity (New in v2.1)
    ],
    searchableAttributes: [
        "title",
        "sku"
    ]
}
```

---

## Frontend Structure

### Interactive Sorting

**File**: `/src/admin/routes/inventory-advanced/hooks/use-inventory-search.ts`

The hook manages the sort state, defaulting to `title:asc` but supporting:
*   `totalReserved:asc` / `desc`
*   `totalStock:asc` / `desc`
*   `price:asc` / `desc`
*   `sku:asc` / `desc`

When a user clicks a table header (e.g., "Reserved"), the `InventoryTable` component calls `onSortChange` which updates the local state and triggers a new query via the Search Proxy.

### Component Updates

1.  **InventoryTable**:
    *   Headers are now interactive (`HeaderCell` component).
    *   Visual indicators (arrows) show sort direction.
    *   Column "Reserved" is fully sortable.
    *   **Navigation**: Replaced imperative `onClick` with declarative `<Link>` components to support **Middle-Click** (new tab) and native browser behavior.
    *   **Styling**: Applied `flex items-center` to table cells to ensure perfect vertical alignment of text.

2.  **InventoryHeader**:
    *   Dropdown menus have increased `max-height` (300px) for better usability.
    *   Added explicit sort options for Reserved Low/High.

---

## Critical Decisions

### 1. ✅ Sync on Mount (Blocking)
**Decision**: Every time the user visits the page, we force a sync.
**Reasoning**: Inventory data changes frequently (orders, manual edits). A cached view leads to overselling.
**Implementation**: `useEffect` triggers the sync workflow. The frontend shows "Loading..." until the workflow *and* MeiliSearch indexing are 100% complete.

### 2. ✅ Search Proxy Pattern
**Decision**: Proxy all search traffic through the Medusa Backend.
**Reasoning**: Eliminates CORS headaches forever. Simplifies frontend env management (no need for public search keys). Securely uses the Master Key server-side.

### 3. ✅ Workflow-Based Sync
**Decision**: Move logic from API route to Medusa Workflow.
**Reasoning**: Workflows are the v2 standard. They allow for better error handling, step retry, and easier integration with other modules later.

---

## Troubleshooting

### "Reserved" Sorting Not Working?
*   **Cause**: MeiliSearch settings might be stale.
*   **Fix**: Reload the page. The Sync Workflow runs on load and *updates the index settings* to include `totalReserved` in `sortableAttributes`.

### 404 on Search?
*   **Cause**: The proxy route path might be incorrect in the hook.
*   **Fix**: Ensure `use-inventory-search.ts` points to `/admin/search/inventory/query` (not `/search`).

### "Redis URL not found"
*   **Cause**: `medusa-config.js` (empty file) existing alongside `medusa-config.ts`.
*   **Fix**: Delete `medusa-config.js`.

---

**Status**: ✅ Production Ready (v2.1)
