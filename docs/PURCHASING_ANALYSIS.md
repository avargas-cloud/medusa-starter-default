# Purchasing Analysis — System Documentation

End-to-end documentation for the purchasing analysis pipeline: revenue-weighted Pareto ranking, ABC × XYZ classification, demand forecasting, and reorder recommendations across the EcoPowerTech catalog.

> **Audience**: backend engineers and inventory analysts who need to understand, debug, or extend the system.
> **Last updated**: 2026-04-27 (after the QB → Medusa cutover bridge work).

---

## 1. What the system does

For every active product variant in the catalog, the system answers four questions every night (and on demand when relevant orders post):

1. **How much is this SKU really selling per month right now?** (recency-weighted demand)
2. **What's its share of revenue, and what XYZ variability class does it belong to?** (Pareto + CV)
3. **Are we going to run out before the next ship from China?** (qty to transfer USA)
4. **Should the factory in China make more?** (qty to factory)

The output is the `purchasing_snapshot` table — one row per variant — consumed by the **store-pos** Purchasing Analysis screen (`/purchasing-analysis`) and the **product alternatives** workflow.

Three layers cooperate:

```
          ┌──────────────────────────────────────────────────────┐
          │  Sources                                              │
          │  • pos_invoice / pos_invoice_item   (Medusa POS)      │
          │  • purchasing_sales_history         (QB excel + Medusa│
          │                                       monthly cron)   │
          │  • inventory_level                  (USA + China)     │
          │  • purchase_order_line              (open POs)        │
          │  • product_alternative              (substitutes)     │
          │  • product_variant.metadata         (per-SKU overrides)│
          └────────────────────┬─────────────────────────────────┘
                               │
                               ▼
          ┌──────────────────────────────────────────────────────┐
          │  Engine (pure RAM, no per-variant DB calls)           │
          │  • daily-sales-engine.ts                              │
          │  • pareto-engine.ts                                   │
          │  • snapshot.service.ts (orchestrator)                 │
          └────────────────────┬─────────────────────────────────┘
                               │
                               ▼
          ┌──────────────────────────────────────────────────────┐
          │  purchasing_snapshot  (cached, one row per variant)   │
          └────────────────────┬─────────────────────────────────┘
                               │
                               ▼
          ┌──────────────────────────────────────────────────────┐
          │  Admin API                                            │
          │  • GET  /admin/purchasing/snapshot                    │
          │  • GET  /admin/purchasing/monthly-sales (Pareto tab)  │
          │  • GET  /admin/purchasing/alternatives                │
          │  • POST /admin/purchasing/variants/:id/available-since│
          └────────────────────┬─────────────────────────────────┘
                               │
                               ▼
          ┌──────────────────────────────────────────────────────┐
          │  store-pos UI · /purchasing-analysis                  │
          │  • Analysis · Urgent · 12-Month Sales · 80-20 Pareto  │
          │  • Alternatives                                       │
          │  Plus admin widgets in the Medusa product page        │
          └──────────────────────────────────────────────────────┘
```

---

## 2. Recency-weighted demand — the core formula

Flat 12-month averages give equal voice to a sale 11 months ago and a sale yesterday. That distorts purchasing. The engine replaces them with a **5-tier weighted average**:

| Tier | Window | Default weight | Config key |
|------|-----------------|--------:|---------------------|
| **tier0** | most recent ~26 biz days | **30%** | `weight_tier0_30d` |
| **Q4** | last 3 calendar months before tier0 | **25%** | `weight_q4` |
| **Q3** | months 4–6 back | **20%** | `weight_q3` |
| **Q2** | months 7–9 back | **15%** | `weight_q2` |
| **Q1** | months 10–12 back | **10%** | `weight_q1` |

Per tier we compute a **monthly rate** (units/mo) from raw units divided by the tier's Mon–Sat days, scaled to one canonical month (`business_days_per_month = 26`). Then:

```
weighted_demand_monthly  = Σ (weight_tier × monthly_units_tier)
weighted_revenue_monthly = Σ (weight_tier × monthly_revenue_tier)
```

`weighted_revenue` is the **Pareto ranking metric**. The same recency emphasis applies — a SKU whose demand surged in Q4 outranks one whose history was flat across the year.

> **Why monthly rates and not raw sums?** Tiers have different lengths (tier0 ≈ 1 month, Qs are 3 months each). Multiplying a raw 3-month sum by `0.25` would fight against the per-month normalization the tiers are designed for. We always work in `units / mo` and `$ / mo` so the weights compose cleanly.

### Returns are netted at the sale date

Both the unit count and the revenue per tier subtract returns by the **original sale date**, not the return date:

```sql
SUM(quantity - refunded_quantity)                     -- units
SUM((total / 100) * (quantity - refunded_quantity)    -- revenue (cents → dollars)
    / quantity)
```

Rationale: for forecasting we want the cohort's *net realised demand*. Returns of last quarter's sale belong to last quarter, not today.

> ⚠️ **Cents pitfall**: `pos_invoice_item.total` and `unit_price` are stored in **cents**. The engine divides by 100. A bug that read them as dollars produced 100× inflated revenues — see the "Bug history" section below.

### What about quarters with no sales at all?

Two cases must be told apart:

* **Pre-life** — the variant didn't exist or wasn't yet on sale. The corresponding tier should die and its weight should be redistributed to surviving tiers.
* **Alive but no demand** — the variant existed but didn't sell. Those zeros are real signal and must drag the weighted average down.

The engine distinguishes them via the `firstSaleByVariant` map (covered next) plus a **monthly backfill**: between `alive_since` and current month, every missing month is materialised as `{ qty: 0, revenue: 0 }`. From then on, "empty quarter" means "entire quarter pre-life" and only that case dies.

---

## 3. Tier0 has three modes

`tier0` is the most volatile — it covers the freshest data and carries the largest weight. Three modes handle the QB → Medusa cutover and steady state:

| Mode | When | Source | Window |
|------|------|--------|--------|
| `live_window` | Mon-Sat days since 2026-04-14 ≥ 24 | `pos_invoice_item` only | last 26 Mon-Sat days |
| `april2026_combined` | currently in April 2026 and not yet 24 biz days live | QB excel days 1-13 + Medusa POS days 14-today (combined) | 2026-04-01 → today |
| `fallback_prev_month` | post-April but Medusa hasn't yet hit 24 biz days (e.g., very long downtime) | `purchasing_sales_history` only | previous full calendar month |

The **combined mode** exists because Medusa went live 2026-04-14 but the user wanted Pareto reports immediately. We seed April with the partial QB Excel export (days 1-13) and stitch on Medusa POS day-by-day from the 14th forward. The seam is at midnight ET on 2026-04-14.

The mode is decided once per snapshot run by `computeTier0Meta(todayET)` in `services/purchasing/tier0-window.ts`. The same helper runs in both the engine and the `monthly-sales` API route, so the FE can render an accurate banner ("⚠ Tier0 in april2026_combined…") without duplicating the logic.

When fallback or combined mode is active, `Q4..Q1` shifts back one calendar month so tier0 doesn't overlap any quarter. Quarter offsets are exposed as `tier0_meta.quarter_offsets` in the API response.

---

## 4. ABC × XYZ classification

Two orthogonal dimensions, eight bins. Both are stored on `purchasing_snapshot`.

### ABC — revenue Pareto (uses `weighted_revenue` as input)

* Rank all *primary* variants (alts excluded — see §5) descending by `weighted_revenue`.
* Walk the sorted list accumulating revenue share.
* Bucket by `pareto_a_threshold` and `pareto_b_threshold` (defaults 0.80 / 0.95):
  * **A** — cumulative ≤ 80% of revenue (the head)
  * **B** — cumulative 80–95% (the body)
  * **C** — the rest (the long tail)
* Persist `pareto_rank` (1-indexed) too so the UI can sort identically.

Alts inherit a fixed `B` so they never compete in the cumulative ladder; the primary they belong to absorbs their contribution via the bundle aggregation in `calculateDailySales`.

### XYZ — demand variability (coefficient of variation)

For each variant: `cv = stdev(monthly_qty) / mean(monthly_qty)` over the 12-month window.

* **X** — `cv < 0.5` — stable demand (auto-reorderable).
* **Y** — `0.5 ≤ cv < 1.0` — moderate variability (mild safety stock).
* **Z** — `cv ≥ 1.0` — erratic (manual review, big buffer, or candidate to drop).

Combined as `abcxyz_class = ${abc}${xyz}` (e.g. `AX`, `CZ`).

### How to read the matrix at a glance

|        | A (top 80%) | B (next 15%) | C (last 5%) |
|--------|-------------|--------------|-------------|
| **X** stable | **AX** — automate, low safety stock | BX — monthly review | CX — let it run |
| **Y** moderate | AY — monthly review, medium buffer | BY — bimonthly review | CY — quarterly review |
| **Z** erratic | **AZ** — high attention, big buffer | BZ — manual oversight | **CZ** — discontinuation candidate |

The Pareto tab in store-pos colour-codes this matrix: AX green, AY violet, AZ red, CZ gray-strikethrough.

---

## 5. New-product cascade — bundles + `available_since` override

Brand-new SKUs (launched within the last 30 days, say) have almost no own history yet. Two mechanisms keep them from collapsing in the Pareto:

### 5a. Bundle aggregation through alternatives

`product_alternative` links a primary SKU to its substitutable alternates (e.g. a freecut LED from supplier A + the equivalent from supplier B). The engine treats `[primary, ...alts]` as a single bundle:

```ts
const allIds = [primaryVariantId, ...altVariantIds]
const tier0Invoiced  = allIds.reduce((s, id) => s + (ctx.tier0ByVariant.get(id) ?? 0), 0)
// histByVariant rows are merged month-by-month into combinedQty / combinedRev
const firstSaleISO   = min(allIds.map(id => firstSaleByVariant[id]).filter(Boolean))
```

Result: a brand-new primary inherits all the demand history that lives on its older alt. The API sets `data_source = 'alternative_proxy'` so the UI can show a small badge. Without alts, very-new variants get `data_source = 'partial'` and their weights renormalise across whatever quarters are alive.

> The **primary's** `weighted_revenue` IS the bundle's weighted revenue. The API exposes `combined_weighted_revenue = primary.weighted_revenue` directly — adding alts' standalone weighted on top would double-count.

### 5b. `metadata.available_since` — manual override

Sometimes the engine can't tell *alive but quiet* from *pre-life* automatically. Example: a SKU exists in QB for 18 months but only sold in 1 of them. Without help, the engine drops 11 quarters as pre-life and the SKU floats up to class A on 1 month of sales — clearly wrong.

The override fixes this. Per variant:

```sql
UPDATE product_variant
SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('available_since', '2025-04-15')
WHERE sku = 'ABC-1234';
```

The engine reads this column with a `COALESCE(override, MIN(actual_first_sale))` — **override wins when present**, falling back to the earliest real sale otherwise.

A bulk SQL run on **2026-04-27** seeded `available_since = today − 395d` for all 2,567 variants. So by default everything is treated as fully-available the last 12+ months. Genuinely new products are corrected manually via the admin widget on the variant page (zone `product.details.after`). The widget posts to:

```
POST /admin/purchasing/variants/:id/available-since
Body: { "available_since": "YYYY-MM-DD" | null }
```

That endpoint updates the metadata and immediately recalculates the variant's snapshot row via `recalculateForVariants([variantId])`.

---

## 6. Data pipeline & files

### Engines (pure, synchronous, no DB inside the variant loop)

| File | Responsibility |
|------|----------------|
| `services/purchasing/daily-sales-engine.ts` | `buildSalesEngineContext()` (one bulk load per run) and `calculateDailySales()` (per-variant pure math). Outputs `tier0_30d`, `sales_q1..q4`, `daily_sales_est`, `monthly_sales_est`, `cv`, `weighted_revenue`, `first_sale_date`. |
| `services/purchasing/pareto-engine.ts` | `runParetoEngine(variants, cfg)` — sorts by `revenue` descending, assigns ABC + XYZ + `pareto_rank`. |
| `services/purchasing/tier0-window.ts` | `computeTier0Meta(todayET)` — pure date math; chooses live / fallback / april2026_combined and produces window dates, biz days, label, quarter offsets. |
| `services/purchasing/snapshot.service.ts` | Orchestrator. Loads context once, walks all variants in RAM, batches upserts of 200 rows, smart-skips when nothing changed. |
| `services/purchasing/consolidate-monthly-sales.service.ts` | Closes a month: aggregates `pos_invoice_item` for that calendar month into `purchasing_sales_history` with `source = 'medusa_orders'`. |
| `services/purchasing/missing-month-check.ts` | Returns warnings for the API when a recently-closed month isn't yet in `purchasing_sales_history`. |
| `services/purchasing/purchasing-config.service.ts` | Loads tier weights, ABC thresholds, XYZ thresholds, `business_days_per_month`, etc. from `purchasing_config`. |

### Admin API routes

| Route | Purpose |
|-------|---------|
| `GET /admin/purchasing/snapshot` | Full snapshot grid for the Analysis / Urgent / Sales tabs. Includes alts joined under primaries, plus `tier0_meta` and any `warnings`. |
| `GET /admin/purchasing/monthly-sales` | Per-SKU month-by-month sales for the Pareto / 12-Month Sales tabs. Joins snapshot fields (`weighted_revenue`, `pareto_rank`, `abc_class`, `xyz_class`) and computes `data_source` per row. |
| `GET /admin/purchasing/alternatives` | Primary → alt links + aggregated alt inventory & on-PO. |
| `GET /admin/purchasing/alternatives/:variantId` | Detail for one primary's alts. |
| `POST /admin/purchasing/variants/:id/available-since` | Set/clear the manual override; auto-runs `recalculateForVariants`. |
| `GET /admin/purchasing/variants/search` | MeiliSearch-backed quick lookup for the alts modal. |
| `POST /admin/purchasing/recalculate` | Trigger a snapshot run by hand. |
| `GET /admin/purchasing/config` / `POST` | Read & update tier weights, thresholds, etc. |

### Background jobs

| Job | Schedule | What it does |
|-----|----------|--------------|
| `purchasing-snapshot-cron` | nightly (configured in `purchasing_config.cron_schedule`) | Full `runPurchasingSnapshot()`. Smart-skips unchanged variants — same-day re-runs are near-instant. |
| `consolidate-monthly-sales-cron` | day 2 of each month, 03:00 ET | Closes the previous month: aggregates Medusa POS into `purchasing_sales_history` with `source = 'medusa_orders'`. |
| `missing-april-2026-reminder` | one-shot (auto-silences when QB Excel for April is loaded) | Surfaces a `warnings` item in `/admin/purchasing/snapshot` until the historical bridge data is present. |

### One-off scripts (`src/scripts/sync/` and `src/scripts/verify/`)

* `run-purchasing-snapshot.ts` — runs the full snapshot directly (no HTTP auth required).
* `recalculate-purchasing-snapshot.ts` — same with `--force` semantics.
* `import-april-2026-partial.ts` — loads the QB Excel days 1-13 of April 2026 into `purchasing_sales_history` (source = `excel_import`). Required for `april2026_combined` mode.
* `backfill-monthly-sales-from-medusa.ts` — for any month: aggregates POS invoices and writes them as `medusa_orders`. Useful after consolidator failures.
* `verify-tier0-fallback.ts` — sanity-checks the tier0 window selection and DB content (rows present, biz days correct, etc.).

---

## 7. Database schema (relevant columns)

### `purchasing_snapshot` — output cache (one row per variant)

| Column | Type | Notes |
|--------|------|-------|
| `variant_id` | text PK | FK to `product_variant.id` |
| `tier0_30d` | numeric | normalised monthly rate (daily × `biz_per_month`) |
| `sales_q1..q4` | numeric | raw unit totals in each rolling 3-month tier |
| `sales_last_24d` | numeric | last ~28 calendar days (≈4 Mon-Sat weeks), informational |
| `cv` | numeric | coefficient of variation (XYZ input) |
| `daily_sales_est` | numeric | weighted daily units (× `1 + tendency_adj`) |
| `monthly_sales_est` | numeric | `daily_sales_est × biz_per_month` |
| `weighted_revenue` | numeric(14,2) | tier-weighted monthly NET revenue — **Pareto ranking metric** |
| `pareto_rank` | integer null | 1-indexed rank by `weighted_revenue` desc; null when revenue ≤ 0 |
| `abc_class` | text | A / B / C |
| `xyz_class` | text | X / Y / Z |
| `abcxyz_class` | text | combined, e.g. `AX` |
| `first_sale_date` | date null | bundle MIN across primary + alts; respects `metadata.available_since` |
| `inv_usa` / `inv_china` | int | current stocked qty per warehouse |
| `qty_to_transfer` | int | suggested USA reorder (China → Miami) |
| `qty_to_factory` | int | suggested factory reorder (effective lead = production_days × ABC factor) |
| `qty_on_po_*` | int | open POs filling the pipeline |
| `production_days` | int | per-variant override (defaults to vendor metadata, fallback 10) |
| `unmet_net_30d` | numeric | requested − purchased forced alternates |
| `last_calculated_at` | timestamptz | smart-skip key |

### `purchasing_sales_history` — monthly aggregates

| Column | Type | Notes |
|--------|------|-------|
| `variant_id` | text | |
| `month_date` | date | always day-1 of the month |
| `qty_sold` | int | NET (returns subtracted at sale date) |
| `revenue` | numeric | NET in dollars |
| `source` | text | `excel_import` (QB Excel) or `medusa_orders` (POS-derived). Engine prefers `medusa_orders` via `DISTINCT ON`. |

### `product_alternative` — primary ↔ alt links

| Column | Type | Notes |
|--------|------|-------|
| `primary_variant_id` | text | the canonical SKU |
| `alt_variant_id` | text | substitutable alternative |
| `priority` | int | 1 = preferred fallback |
| `is_active` | boolean | |
| `deleted_at` | timestamptz | soft delete |

### `product_variant.metadata` — per-SKU overrides

| Key | Type | Effect |
|-----|------|--------|
| `available_since` | string `YYYY-MM-DD` | overrides the engine's first-sale detection (see §5b) |
| `sales_description` | string | shown in the Pareto / Sales / Alternatives UIs |
| `qb_vendor_list_id` | string | links a variant to the QB vendor row that supplies `production_days` |

### `purchasing_config` — tunables

Single-row K/V table with the default tier weights, thresholds, and lead-time buffers. Loaded once per snapshot run; UI exposes it under `/admin/purchasing/config`.

Defaults today (2026-04-27):

```
weight_tier0_30d   = 0.30
weight_q4          = 0.25
weight_q3          = 0.20
weight_q2          = 0.15
weight_q1          = 0.10
tendency_adj       = 0.05
business_days_per_month = 26
pareto_a_threshold = 0.80
pareto_b_threshold = 0.95
xyz_x_threshold    = 0.50
xyz_y_threshold    = 1.00
transit_air_days   = 7
buffer_air_days    = 7
```

---

## 8. UI (store-pos `/purchasing-analysis`)

Five tabs, all driven by snapshot data:

| Tab | What it shows | Backed by |
|-----|---------------|-----------|
| Analysis | Full grid: SKU, class, sales/day, sales/mo, inv USA, inv China, days of cover, qty to transfer, qty to factory | `/admin/purchasing/snapshot` |
| Urgent | Filtered Analysis — stock negative or coverage < lead time. Toggles "consider alternative supply" | same |
| 12-Month Sales | Per-SKU month-by-month grid; primaries with their alts nested | `/admin/purchasing/monthly-sales` |
| 80-20 Pareto | Combined `Class` badge (AX/AY/AZ…), `Sales (12m)` informational column, `Weighted $/mo` ranking column with rich tooltip, cumulative bars | same as 12-Month Sales |
| Alternatives | Primary ↔ alt management (admin) | `/admin/purchasing/alternatives` |

### `WeightedTooltip` — the centrepiece of the Pareto tab

Hovering the `Weighted $` cell opens a popover that breaks down the Pareto metric per tier:

```
$X,XXX / mo                                        Pareto metric
Tier-weighted monthly revenue, NET of returns. Recency-weighted.

┌──────┬──────────────────────────────┬───────┬─────────┬──────────┬────────┐
│ Tier │ Window                       │ Units │ Sales   │ Sales/mo │ Weight │
├──────┼──────────────────────────────┼───────┼─────────┼──────────┼────────┤
│Recent│ Apr 1 – Apr 26 (22 biz days)⚠│   200 │   —     │  $4,139  │  30%   │
│  Q4  │ Jan 26 – Mar 26              │   599 │ $13,659 │  $4,553  │  25%   │
│  Q3  │ Oct 25 – Dec 25              │   523 │ $11,259 │  $3,753  │  20%   │
│  Q2  │ Jul 25 – Sep 25              │   524 │ $10,818 │  $3,606  │  15%   │
│  Q1  │ Apr 25 – Jun 25              │   536 │ $11,169 │  $3,723  │  10%   │
└──────┴──────────────────────────────┴───────┴─────────┴──────────┴────────┘

Σ weight × monthly NET revenue per tier = $X,XXX/mo · effective price ≈ $20.74/u

Flat 12m       $48,606 total           Weighted    $X,XXX /mo
              ≈ $4,051/mo simple avg               recency-adjusted

Tier0 source   ⚠ fallback / live
Demand source  self / alternative_proxy / partial
Own first sale 2025-04-01
Class          AX / AY / AZ ...
```

* **Sales** column = total revenue inside the tier window (Q's = 3 months, tier0 = 1 month so it's hidden as `—` to avoid duplicating Sales/mo).
* **Sales/mo** for Q's = `Sales / 3`. For tier0 in `fallback_prev_month` it's read directly from the bundle's monthly array; in `april2026_combined` and `live_window` it's approximated as `tier0_units × effective_price` because the window mixes partial/multiple sources that aren't fully in `purchasing_sales_history` yet.

### Tier0 fallback banner (Pareto tab)

Shown only while `tier0_meta.in_fallback_mode === true`:

```
⚠ Tier0 en april2026_combined: días 1-13 desde QB Excel + días 14-N desde
   Medusa POS · auto-switchea a "últimos 26 biz days" cuando Medusa
   acumule 24 biz days live (~14-may-2026)
```

Once the Medusa live window has 24 biz days, the banner disappears automatically.

### Variant `available_since` widget (Medusa admin)

`backend/src/admin/widgets/variant-available-since-widget.tsx` — zone `product.details.after`. Shows every variant of the product with a date input, "13m+" shortcut button (defaults to today − 395 days), and "Clear" (removes override). Saving POSTs to the endpoint and triggers a partial recalc. A toast confirms the Pareto recalculation.

---

## 9. Operations runbook

### Running a manual snapshot

```bash
cd backend
DATABASE_URL=$(grep ^DATABASE_URL .env | cut -d= -f2-) \
  yarn tsx -e "
    import { runPurchasingSnapshot } from './src/services/purchasing/snapshot.service';
    runPurchasingSnapshot({ force: true })
      .then(r => console.log(r))
      .catch(e => { console.error(e); process.exit(1); });
  "
```

`force: true` bypasses the smart-skip and rewrites every row. Without it, only variants with new orders since `last_calculated_at` are touched.

### Closing a past month

When the cron fails or you need to backfill January 2026:

```bash
month=2026-01-01 npx medusa exec ./src/scripts/sync/backfill-monthly-sales-from-medusa.ts
# Or a range:
from=2026-01-01 to=2026-03-01 npx medusa exec ./src/scripts/sync/backfill-monthly-sales-from-medusa.ts
```

After backfill, run the snapshot again so `weighted_revenue` reflects the new history.

### Loading the QB Excel for April 2026

```bash
npx medusa exec ./src/scripts/sync/import-april-2026-partial.ts
```

This is what flips off the `missing-april-2026-reminder` warning in the snapshot response.

### Setting `available_since` for a specific SKU

UI path (recommended): open `/app/products/<product_id>` in the Medusa admin, scroll to "Available Since (Pareto)", set the date, click Save. The endpoint auto-recalculates that variant's snapshot row.

Direct SQL (one-off, for debugging only):

```sql
UPDATE product_variant
SET metadata = COALESCE(metadata, '{}'::jsonb)
             || jsonb_build_object('available_since', '2025-04-15')
WHERE sku = 'ABC-1234';
```

Then either trigger the cron or run a manual snapshot. The single-variant API endpoint takes care of the recalc automatically.

### Verifying tier0 mode picked correctly

```bash
DATABASE_URL=$(grep ^DATABASE_URL .env | cut -d= -f2-) \
  yarn tsx src/scripts/verify/verify-tier0-fallback.ts
```

Prints `tier0Source`, `tier0Label`, window dates, biz days, sample variant counts, and a sanity cross-check against `purchasing_sales_history`. Useful before/after the QB→Medusa transition windows.

### Debugging a "wrong" Pareto rank

1. Find the variant: `psql -A -t -c "SELECT id FROM product_variant WHERE sku = 'XXX'"`.
2. Pull its snapshot row: `weighted_revenue`, `pareto_rank`, `tier0_30d`, `sales_q1..q4`, `first_sale_date`.
3. Compare with raw history: `SELECT month_date, qty_sold, revenue FROM purchasing_sales_history WHERE variant_id = '...' ORDER BY month_date`.
4. If the SKU has alts, also pull each alt's `weighted_revenue` and history. The primary's `weighted_revenue` IS the bundle (primary + alts). Don't add alts on top.
5. If `first_sale_date` looks wrong, check `metadata->>'available_since'`.

---

## 10. Bug history (so the same trap doesn't reopen)

These were all fixed during the 2026-04-27 cutover work. Worth keeping in mind.

* **Cents pitfall** — `pos_invoice_item.total` and `unit_price` are integer cents. The first version of the tier0 query treated them as dollars and produced 100× inflated revenues. Always `(pii.total::numeric / 100)` before doing the qty-net scaling.
* **Order of operations in the API** — `monthly-sales/route.ts` originally applied snapshot fields *before* injecting "primary rows with no own sales but with alts" into the row map. New SKUs whose demand came from alternatives ended up with `weighted_revenue = 0` and rank ~600. Snapshot is now applied **after** primary injection.
* **Sales description missing for new primaries** — the same injection step used to set only `sku` and `product_title`. The fallback would render the bare product title (e.g. `ESP-SFA50W10`) instead of the variant description. Now reads `pv.metadata->>'sales_description'` from the alt-links query and sets it on the injected row.
* **Bundle double-count** — early code had `combined_weighted_revenue = primary.weighted_revenue + Σ alts.weighted_revenue`. The primary's value already IS the bundle (the engine merged primary + alts into `combinedQty`/`combinedRev`). Adding alts again roughly doubled it. Fixed: `combined_weighted_revenue = primary.weighted_revenue`.
* **Leading-zero quarter rule** — when `metadata.available_since` was added, the older `taggedQuarters` walk that skipped leading-zero quarters became wrong (it was killing real "alive but quiet" quarters). Replaced by `alive = (slice.length > 0)` because the monthly backfill now guarantees every alive month is materialised.
* **History 12mo cutoff drift** — `WHERE month_date >= (NOW() - INTERVAL '12 months')::date` excluded the 1st of the same calendar month a year ago (e.g., on 2026-04-27 it cut at 2025-04-27 and excluded 2025-04-01). Now `DATE_TRUNC('month', NOW() - INTERVAL '13 months')` so the engine sees a clean 13-month window.

---

## 11. Migrations & history

| Migration | Date | What it added |
|-----------|------|----------------|
| `Migration20260424000000` | 2026-04-24 | Initial purchasing module — `product_alternative`, `purchasing_config`, `purchasing_snapshot`, `purchasing_sales_history`. `weighted_revenue` and `pareto_rank` columns scaffolded (initially unwired). |
| `Migration20260426000000` | 2026-04-26 | Snapshot index/constraint tweaks. |
| `Migration20260427000000` | 2026-04-27 | Adds `first_sale_date date null` to `purchasing_snapshot`. Persisted by the engine; consumed by the API to derive `data_source`. |

Bulk SQL operation on **2026-04-27** (one-off, not a migration): `UPDATE product_variant SET metadata = metadata || jsonb_build_object('available_since', today − 395 days)` for every active variant. Default-treats the catalogue as fully-available the last 12+ months. New SKUs are corrected per-SKU via the admin widget.

---

## 12. Glossary

| Term | Meaning |
|------|---------|
| **bundle** | a primary variant + its active alternates, treated as a single demand unit. |
| **tier0** | the most recent demand window, weight 30%. Three modes (live / april2026_combined / fallback_prev_month) by date. |
| **weighted_revenue** | tier-weighted monthly NET revenue. Pareto ranking metric. |
| **pareto_rank** | 1-indexed position in the descending `weighted_revenue` list (only primaries; null when revenue ≤ 0). |
| **abc_class** | A / B / C — by cumulative `weighted_revenue` share. |
| **xyz_class** | X / Y / Z — by CV of monthly demand. |
| **data_source** | exposed by the API per row: `self` (≥12 mo own history), `alternative_proxy` (primary new, alt has 12+), `partial` (<12 mo and no alt covers), `none` (never sold). |
| **available_since** | manual override stored in `pv.metadata`. Wins over real first-sale detection when set. |
| **biz days** | Mon–Sat (no Sunday). The engine's denominator everywhere except the 12-month flat sums. |
| **business_days_per_month** | canonical `26` (config). Used to scale per-tier monthly rates uniformly. |
