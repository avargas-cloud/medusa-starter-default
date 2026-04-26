# Purchasing Analysis — Backend Algorithm

## Overview

The purchasing analysis system pre-computes replenishment recommendations for every active product variant and stores them in the `purchasing_snapshot` table. A nightly cron job keeps the snapshot current; a subscriber triggers partial recalculation on every fulfilled order so recommendations reflect real-time sales without waiting for the next scheduled run.

---

## Database Tables

### `purchasing_snapshot`

One row per `variant_id`. Updated by the batch cron or the per-order subscriber.

| Column | Type | Description |
|--------|------|-------------|
| `variant_id` | text PK | Foreign key to `product_variant.id` |
| `tier0_30d` | int | Units sold in the last 30 days (raw) |
| `sales_q1..q4` | int | Units sold per rolling 90-day quarter |
| `sales_last_24d` | int | Units sold in the last 24 days (≈ 4 weeks) |
| `cv` | numeric | Coefficient of variation of weekly sales |
| `daily_sales_est` | numeric | Smoothed daily sales estimate |
| `monthly_sales_est` | numeric | `daily_sales_est × 30` |
| `abc_class` | text | `A` / `B` / `C` (revenue Pareto) |
| `xyz_class` | text | `X` / `Y` / `Z` (demand volatility) |
| `abcxyz_class` | text | Combined, e.g. `AX`, `BZ` |
| `inv_usa` | int | Current stocked quantity, Miami warehouse |
| `inv_china` | int | Current stocked quantity, China warehouse |
| `qty_to_transfer` | int | Recommended units to ship from China → Miami |
| `qty_to_factory` | int | Recommended units to reorder from factory |
| `production_days` | int | Effective production days used in factory formula |
| `last_calculated_at` | timestamptz | Timestamp of last upsert |

### `purchasing_category_sku`

Maps SKUs to custom analysis categories (e.g. "Generator Cables", "Solar Panels"). Primary key is `(category, sku)`. Replaces the previous filesystem JSON approach to survive deploys and avoid race conditions.

---

## Snapshot Computation — Full Run

Entry point: `snapshot.service.ts → computeSnapshot()`

The full run executes six parallel queries, then processes results in two passes.

### Pass 1 — Parallel data load

```
Promise.all([
  1. Daily sales per variant (last 12 months, by quarter + last 24d)
  2. Inventory levels (Miami + China)
  3. Open PO quantities (Miami + China, status submitted/partially_received)
  4. ABC/XYZ classification from pareto-engine
  5. Vendor production days (from qb_vendor.metadata->>'production_days')
])
```

### Pass 2 — Per-variant calculation

For each variant:

**Daily sales estimate (`daily_sales_est`)**

Uses a weighted average across four rolling 90-day quarters:

```
weights = [0.4, 0.3, 0.2, 0.1]   # Q1 is most recent
rawEst = Σ(salesQN / 90 × weightN)
```

If the last 30 days sold more than `rawEst × 30`, the estimate is bumped to `tier0_30d / 30` to catch acceleration.

**Coefficient of Variation (`cv`)**

Measures demand volatility across the four quarterly rates. `cv = stddev / mean`. Used for XYZ classification.

**Transfer quantity (`qty_to_transfer`)**

```
safetyStock = daily × transitDays        # transitDays = chinaToUsaDays if sourced via agent
targetStock  = daily × invDays + safetyStock
qty_to_transfer = max(0, targetStock − inv_usa − onOrderUSA)
```

`invDays` defaults (configurable): A-class = 30 days, other = 15 days.

**Factory quantity (`qty_to_factory`)**

```
factoryMult  = { A: 1.0, B: 0.7, C: 0.5 }[abc_class] ?? 0.5
effectiveDays = round(productionDays × factoryMult)
production_days = effectiveDays          # stored in snapshot
qty_to_factory = max(0, daily × effectiveDays − inv_china)
```

`productionDays` is read from the linked QBW vendor's `metadata->>'production_days'` (defaults to 10 if unset).

**Batch upsert**

Results are written in batches of 200 rows using a single multi-row `INSERT … ON CONFLICT (variant_id) DO UPDATE SET …` statement.

---

## ABC/XYZ Classification — `pareto-engine.ts`

**ABC (revenue contribution)**

Variants are ranked by `daily_sales_est` descending. Cumulative share is computed after adding each variant:
- A: cumulative ≤ 70 %
- B: cumulative ≤ 90 %
- C: remainder

The boundary is tested *after* adding the variant (post-addition), so the variant that pushes past the threshold is included in the higher class.

**XYZ (demand regularity)**

Coefficient of variation thresholds:
- X: cv ≤ 0.5 (stable)
- Y: cv ≤ 1.0 (moderate)
- Z: cv > 1.0 (erratic)

---

## Partial Recalculation — Per-Order Subscriber

Entry point: `snapshot.service.ts → recalculateForVariants(variantIds[])`

Triggered by `purchasing-snapshot-on-event.ts` subscriber on `order.fulfillment_created`.

Only recomputes the variants in the fulfilled order, using three targeted queries:
1. Inventory levels for those variants
2. Open PO quantities for those SKUs
3. Existing snapshot data (abc/xyz class, sales estimates) for those variants

Updates `qty_to_transfer`, `qty_to_factory`, and `production_days` without touching ABC/XYZ classification (which requires the full Pareto pass).

---

## Cron Schedule

`src/jobs/purchasing-snapshot-cron.ts` — runs nightly via Medusa's job scheduler. Calls `computeSnapshot()` for all variants.

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/purchasing/snapshot` | Paginated snapshot with filters (`abc`, `xyz`, `q`, `sku[]`, `limit`, `offset`) |
| GET | `/admin/purchasing/snapshot/:variantId` | Single variant snapshot |
| POST | `/admin/purchasing/recalculate` | Trigger full snapshot recalculation |
| GET | `/admin/purchasing/alternatives/:variantId` | Alternatives for a primary variant |
| POST | `/admin/purchasing/alternatives` | Link an alternative variant |
| DELETE | `/admin/purchasing/alternatives/:linkId` | Remove an alternative link |
| GET | `/admin/purchasing/categories` | Category→SKU mapping |
| PUT | `/admin/purchasing/categories` | Replace full category mapping (transactional) |
| GET | `/admin/purchasing/config` | Analysis settings (invDays, chinaToUsaDays, tendency) |
| PUT | `/admin/purchasing/config` | Update analysis settings |
| GET | `/admin/purchasing/monthly-sales` | 12-month sales history by variant |
| GET | `/admin/purchasing/variants/search` | SKU/title search for the alternatives picker |

### Query parameter detail — `/snapshot`

- `abc=A,B` — filter by ABC class (comma-separated)
- `xyz=X,Y` — filter by XYZ class
- `q=text` — case-insensitive SKU or title search
- `sku[]=SKU1&sku[]=SKU2` — exact SKU list (array syntax parsed by qs)
- `limit` — max 5000, default 200
- `offset` — default 0

The response includes two computed columns not stored in the snapshot:
- `qty_on_po` / `qty_on_po_china` — live open-PO quantities (subquery JOIN)
- `max_daily_sales` — max of the DB-derived daily peak and an Excel import (`purchasing-peak-sales.json`)

---

## Shared Infrastructure — `_lib/`

### `_lib/db.ts`

Singleton `pg.Pool` (max 10 connections) shared by all purchasing routes. Usage:

```typescript
return withDb(async (db) => {
  const rows = await db.query(sql, params)
  return res.json(rows.rows)
})
```

Avoids opening a new `pg.Client` per request, which exhausts DB connections under load.

### `_lib/peak-sales.ts`

Lazy-loaded cache of `purchasing-peak-sales.json` (manually imported Excel peak data). Shared by the snapshot and alternatives routes so the file is read only once per process.

---

## SQL Parameter Safety

All dynamic values (location IDs, filter arrays, pagination) are passed as `$N` positional parameters — never interpolated into the SQL string. The COUNT query and the main SELECT share the same `params` array but location IDs are appended **after** COUNT executes to avoid a parameter-count mismatch (Postgres error `08P01`).
