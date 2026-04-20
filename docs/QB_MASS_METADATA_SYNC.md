# QuickBooks Mass Metadata Sync

Bulk reconciles QB item metadata (accounts, vendor, cost, MPN, descriptions, edit sequence, is_active) into Medusa for every active item. Dry-run first, apply with snapshot, rollback available.

Scope: **metadata only**. Stock is per-site (`sync-inventory-core.ts`). Prices are separate (`sync-qb-prices-core.ts`). Shipping dimensions (weight/length/width/height) are not in QB Desktop — they live in `inventory_item.metadata`.

## Canonical storage mapping

| QB field (bulk query) | Medusa level | Metadata key |
|---|---|---|
| `ListID` | variant | `quickbooks_id` |
| `Name`/`FullName` | variant | `sku` (column) + `metadata.qb_sku` |
| `EditSequence` | variant | `qb_edit_sequence` |
| `IsActive` | variant | `qb_is_active` |
| `ManufacturerPartNumber` | variant | `mpn` |
| `SalesDesc` | **variant** | `sales_description` |
| `PurchaseDesc` | variant | `qb_purchase_desc` |
| `PurchaseCost` | variant | `qb_purchase_cost` |
| `AverageCost` | variant | `qb_avg_cost` |
| `IncomeAccountRef.FullName` | product (default) | `qb_income_account_full_name` |
| `COGSAccountRef.FullName` | product (default) | `qb_cogs_account_full_name` |
| `PrefVendorRef.FullName` | product (default) | `qb_vendor_full_name` |
| `PrefVendorRef.ListID` | product (default) | `qb_vendor_list_id` |
| Vendor link | variant | link table `qb_vendor ↔ product_variant` (authoritative) |
| itemType (Inventory/Service/NonInventory) | product | `qb_item_type` |

**Overrides**: when a sibling variant's QB value differs from the product default, store in variant metadata as `qb_override_income_account` / `qb_override_cogs_account` / `qb_override_vendor_full_name` / `qb_override_vendor_qb_id`. Clearing an override (because it now matches the product default) removes the key entirely from the JSON object.

**Excluded from this sync:**
- `QuantityOnHand` — wrong at global level; use `sync-inventory-core.ts` (per-site via `/api/products/site/:warehouseId`).
- `SalesPrice` — separate scope (`sync-qb-prices-core.ts`).
- `AssetAccountRef` — only set at item creation in QB, never changes; not useful to sync.
- weight/length/width/height — not a QB concept. Shipping attrs live on `inventory_item.metadata`.

## Field-absence semantics (conservative)

The snapshot of a QB item preserves a three-state distinction:

- `undefined` = QB did NOT include the field in its response → **skip, no touch**. Prevents accidental deletion when the item type doesn't expose the field (e.g. Service items have no `PurchaseCost` in the Inventory shape).
- `null` = QB included the field but it was empty/whitespace → write `null` to Medusa (clear the key).
- value = QB reported a real value, including `0` or `""` → write it.

Rationale: trust QB as the source of truth but never overwrite Medusa data just because a response shape lacks a field for that item type.

## Two-pass classifier

Each Medusa product has a **driver variant** (first `variant.id` ASC). Drivers set the product-level defaults; siblings decide whether they need an override.

Pass A — drivers:
1. `classify(qb, driverVariant, product, isDriver=true)` → may emit product diffs (income, cogs, vendor name/id, item_type) + variant diffs (direct fields).
2. `computeProposedDefaults(driverQb, product)` → cached per product for pass B.

Pass B — siblings:
1. `classify(qb, siblingVariant, product, isDriver=false, proposedDefaults)` → compares sibling's QB values against the DRIVER's proposed defaults (not the stale `product.metadata`).
2. Emits override diffs only when sibling truly differs from the new default.
3. Clears existing overrides that now equal the new default (`OVERRIDE_CLEARED` classification when the only changes are clearings).

Without two-pass, siblings would emit redundant overrides whenever the product was previously blank and the driver is about to write the default — a silent bug fixed 2026-04-20 during the first live apply smoke test.

## Classifications

| Label | Meaning |
|---|---|
| `NO_CHANGE` | All fields match. |
| `VARIANT_UPDATE` | Only variant.metadata changes (or overrides set). |
| `PRODUCT_UPDATE` | Only product.metadata changes (driver only). |
| `BOTH_UPDATE` | Product + variant changes. |
| `OVERRIDE_CLEARED` | All variant changes are override-clearings. |
| `MISSING_IN_MEDUSA` | QB returned an item Medusa doesn't have (reporting only — no create). |
| `ORPHAN_IN_MEDUSA` | Medusa has a `quickbooks_id` that QB didn't return (reporting only — archive via separate script). |

## Flow

```bash
# 1. Dry run (default — writes plan to /tmp, no DB writes)
npx medusa exec ./src/scripts/qb_sync/core_jobs/mass-metadata-sync.ts

# 2. Subset smoke test
DRY_RUN=false \
  APPLY_ONLY_PRODUCT_IDS=prod_xxxx,prod_yyyy \
  SKIP_LEGACY_CLEANUP=true \
  npx medusa exec ./src/scripts/qb_sync/core_jobs/mass-metadata-sync.ts

# 3. Full apply
DRY_RUN=false npx medusa exec ./src/scripts/qb_sync/core_jobs/mass-metadata-sync.ts

# 4. Archive orphans listed in the plan
PLAN_FILE=/tmp/qb-mass-sync-plan-<ts>.json DRY_RUN=false \
  npx medusa exec ./src/scripts/qb_sync/core_jobs/archive-orphan-products.ts

# 5. Rollback (if needed)
SNAPSHOT_FILE=/tmp/qb-mass-sync-snapshot-<ts>.json \
  npx medusa exec ./src/scripts/qb_sync/core_jobs/rollback-mass-sync.ts

# 6. Verifier (synthetic — no bridge, no DB)
npx medusa exec ./src/scripts/verify/verify-mass-metadata-sync.ts
```

## Apply pipeline (step-by-step)

1. **Fetch from bridge**: `GET /api/products/active-with-description` → poll `GET /api/sync/status/<opId>` every 30s (max 20 attempts).
2. **Parse** `ItemInventoryRet` / `ItemServiceRet` / `ItemNonInventoryRet` into `QbItemRaw` → `toSnapshot()` → `QbItemSnapshot`.
3. **Load Medusa catalog**: variants with `metadata.quickbooks_id`, plus their products.
4. **Two-pass classify** → build `PayloadMap { products, variants }`.
5. **Compute vendor targets**: per variant, `variant.metadata.qb_override_vendor_qb_id ?? product.metadata.qb_vendor_list_id`.
6. **Write snapshot** to `/tmp/qb-mass-sync-snapshot-<ts>.json` (product.metadata + variant.metadata + existing vendor links).
7. **Bulk UPDATE** product.metadata via `UNNEST(?::text[], ?::text[])` in chunks of 500.
8. **Bulk UPDATE** variant.metadata same way.
9. **Vendor link reconcile**:
   - Load existing links from `quickbooks_catalog_qb_vendor_product_product_variant`.
   - Load catalog from `qb_vendor` (1086 rows).
   - For each variant: dismiss any link not pointing to target, create target link.
10. **Legacy cleanup**: one-shot SQL `metadata - 'qb_vendor_id' - 'qb_vendor_name'` across all variants (`SKIP_LEGACY_CLEANUP=true` to skip in subset mode).
11. **Meili reindex**: emit `product.updated` events for every touched product in chunks of 200.

## Rollback

The snapshot file captures pre-apply state of every row that was about to be touched (product.metadata + variant.metadata + vendor-link ids per variant). The rollback script:

1. Restores product.metadata via `UNNEST` UPDATE.
2. Restores variant.metadata via `UNNEST` UPDATE.
3. Reconciles vendor links: dismiss any link not in the snapshot, create any that was.

Rollback does NOT re-run the legacy cleanup (that's one-way, confirmed before apply).

## Verifier (static)

`backend/src/scripts/verify/verify-mass-metadata-sync.ts` runs 28 synthetic scenarios against `classifyMetadataDiff` and the payload builder. Covers:

- All 7 classifications (with and without overrides).
- Field-absence conservative behavior.
- Numeric-equality normalization (`"120.0000"` vs `120`).
- Foreign-key preservation in the payload builder (`qb_price_level`, `shipping_attrs_*` untouched).
- Sibling merge convergence (same product updated via multiple variants yields identical final metadata).
- Two-pass correctness (sibling does NOT emit override when it matches the driver's proposed default).

Run it before any apply run to catch regressions in the diff engine.

## Files

```
backend/src/lib/quickbooks/
└── bulk-item-types.ts                    # QbItemRaw, QbItemSnapshot, toSnapshot, metadata key lists

backend/src/scripts/qb_sync/core_jobs/
├── mass-metadata-sync.ts                 # Entrypoint (fetch + classify + apply)
├── archive-orphan-products.ts            # Flip status=draft from plan.orphans
├── cleanup-legacy-wp-metadata.ts         # WP/WC legacy keys one-shot
└── rollback-mass-sync.ts                 # Replay snapshot

backend/src/scripts/qb_sync/lib/
├── classify-metadata-diff.ts             # Pure diff engine (two-pass)
├── build-update-payload.ts               # Metadata merge preserving foreign keys
├── apply-metadata-sync.ts                # SQL batched writes + link reconcile + cleanup
├── fetch-qb-bulk-items.ts                # Bridge fetch + poll + parse
├── render-dry-run-report.ts              # Tabular report
├── resolve-vendor-links.ts               # Load catalog + existing + plan + apply
├── cleanup-legacy-vendor-keys.ts         # SQL `metadata - 'qb_vendor_id' - 'qb_vendor_name'`
└── snapshot-before-apply.ts              # Write/read snapshot JSON

backend/src/scripts/verify/
└── verify-mass-metadata-sync.ts          # 28 static scenarios

quickbooks-bridge/src/qbxml/builders/
└── item.ts                               # buildItemQueryActiveWithDesc + IncludeRet additions
```

## Changelog

- **2026-04-20**: Initial implementation. Live apply migrated 2240 products + 2550 variants + 2173 vendor links + cleaned 2452 legacy `qb_vendor_id`/`qb_vendor_name` rows in 5.6 min. 4 orphans archived. Bridge extended with 8 new `IncludeRetElement` fields.
