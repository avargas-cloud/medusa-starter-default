---
**Purpose:** Master index and navigation guide for all backend documentation — organized by domain with one-line descriptions.

**Code is the source of truth.** All docs in this index have been verified against actual source code as of April 2, 2026.

---

# Backend Documentation Index

> **Last Updated:** April 2, 2026 | **Total Docs:** 57 + 5 in FIXES/

---

## 🔐 Authentication

| Document | Description |
|---|---|
| [AUTH_COMPLETE_GUIDE.md](AUTH_COMPLETE_GUIDE.md) | **Master guide** — 3 actors (customer/user/pos_user), dual identity, registration, login, password reset, Google OAuth flow |
| [AUTH_GOOGLE_OAUTH.md](AUTH_GOOGLE_OAUTH.md) | Google OAuth — Cloud Console setup, Medusa config, dedup subscriber. **Activo en producción** (`@medusajs/auth-google` carga condicionalmente con `GOOGLE_CLIENT_ID`) |
| [AUTH_POS_STAFF.md](AUTH_POS_STAFF.md) | POS staff auth — uses `user` actor, `pos_users` whitelist table, why `pos_user` is NOT a real auth actor |

---

## 👤 Customers

| Document | Description |
|---|---|
| [CUSTOMERS_ADDRESS_MANAGEMENT.md](CUSTOMERS_ADDRESS_MANAGEMENT.md) | Custom address update route + default-swap logic; why native Medusa endpoint is insufficient |
| [FINANCE_CUSTOMER_BALANCE.md](FINANCE_CUSTOMER_BALANCE.md) | Customer balance formula — how it's calculated from CustomerPayment + PaymentApplication; credit ledger legacy |

---

## 🛍️ Products & Variants

| Document | Description |
|---|---|
| [PRODUCTS_ATTRIBUTES.md](PRODUCTS_ATTRIBUTES.md) | Product attributes system — AttributeSet → Key → Value architecture, admin UI pages/widgets, product linking |
| [PRODUCTS_VARIANTS.md](PRODUCTS_VARIANTS.md) | Dynamic variants system — attribute-driven variant selectors (color swatches, size dropdowns) |
| [PRODUCTS_PRICING.md](PRODUCTS_PRICING.md) | Product pricing — `calculated_price` vs `amount`, region context, major units (all amounts in cents), customer groups |
| [PRODUCTS_LONG_DESCRIPTION.md](PRODUCTS_LONG_DESCRIPTION.md) | Long description — stored in `product.metadata.long_description` as HTML; frontend render patterns |

---

## 🗂️ Categories & Filters

| Document | Description |
|---|---|
| [CATEGORIES_FILTERS.md](CATEGORIES_FILTERS.md) | Category filters complete system — data model, API, nuclear sync algorithm, soft-delete handling |
| [CATEGORIES_IMAGES.md](CATEGORIES_IMAGES.md) | Category images — Admin API limitation workaround via metadata; upload flow |
| [CATEGORIES_PRODUCTS_ENDPOINT.md](CATEGORIES_PRODUCTS_ENDPOINT.md) | Category products endpoint — Knex batch pricing + SQL optimizations for performance |

---

## 🔍 Search (Meilisearch)

| Document | Description |
|---|---|
| [SEARCH_MEILISEARCH.md](SEARCH_MEILISEARCH.md) | Meilisearch system — all indexes (products, customers, orders, inventory), keys, search parameters, why it's preferred over Store API |
| [SEARCH_SYNC_ARCHITECTURE.md](SEARCH_SYNC_ARCHITECTURE.md) | Search sync — 3-layer architecture (middleware → event → scheduled), batch re-index scripts, why middleware replaced subscribers |

---

## 🖼️ Storage

| Document | Description |
|---|---|
| [STORAGE_MINIO.md](STORAGE_MINIO.md) | MinIO S3-compatible storage — `smart-storage` module (active), bucket policies, Railway persistence, folder routing |

---

## 🔌 QuickBooks Bridge

| Document | Description |
|---|---|
| [QB_INTEGRATION_BIBLE.md](QB_INTEGRATION_BIBLE.md) | **Master reference** — bridge architecture, async pipeline pattern, Windows installation, QB document types, kill switch |
| [QB_PIPELINE.md](QB_PIPELINE.md) | `qb_order_pipeline` table — all steps/states, cron job schedules (consolidator runs every 1 min, NOT 2), auto-retry (3 attempts), timeouts |
| [QB_SUBSCRIBERS.md](QB_SUBSCRIBERS.md) | QB event subscribers — 4 verified subscribers + **known bug**: `order.customer_transferred` in switch but not in config array |
| [QB_API_REFERENCE.md](QB_API_REFERENCE.md) | All `/admin/quickbooks/*` endpoints — sync trigger, pipeline status, manual overrides |
| [QB_ADMIN_DASHBOARD.md](QB_ADMIN_DASHBOARD.md) | QB Admin dashboard page — sync status display, manual trigger flow, legacy QB data import (Open SO + Unapplied Payments) |
| [QB_CUSTOMER_IMPORT.md](QB_CUSTOMER_IMPORT.md) | Customer import from QuickBooks — script, field mapping, deduplication strategy, ongoing sync |

---

## 💰 Finance Ledger

| Document | Description |
|---|---|
| [FINANCE_LEDGER.md](FINANCE_LEDGER.md) | **Core ledger** — CustomerPayment + PaymentApplication + QbBankAccount models (all amounts in cents), full flow, API routes |
| [FINANCE_INVOICES.md](FINANCE_INVOICES.md) | PosInvoice — lifecycle, void (surgical inventory rollback), direct-exec QB sync, 3 related models |
| [FINANCE_PAYMENTS.md](FINANCE_PAYMENTS.md) | Payments — web/POS flows, payment methods, apply/void, QB sync (Sales Receipt vs Invoice+Payment vs Write Check) |
| [FINANCE_DOCUMENT_LOCKING.md](FINANCE_DOCUMENT_LOCKING.md) | Redis pessimistic locking — lifecycle, multi-tab reconnect, heartbeat pattern |

---

## 🛒 POS (Point of Sale)

| Document | Description |
|---|---|
| [POS_ARCHITECTURE.md](POS_ARCHITECTURE.md) | **Master guide** — Sales Channels, QB Sales Receipt flow, Credit Ledger, multi-invoice Receive Payment, all POS phases |
| [POS_ORDERS.md](POS_ORDERS.md) | Sales orders — order editing, payment capture, POS discounts, `pos-transfer` |
| [POS_ESTIMATES.md](POS_ESTIMATES.md) | Estimates — create/edit/convert, QB sync, PDF/print flow, note presets, BL link |
| [POS_CUSTOMERS.md](POS_CUSTOMERS.md) | Customer module — search, profile, balance, credit ledger, rankings |
| [POS_INVENTORY.md](POS_INVENTORY.md) | Inventory management — stock levels, location management |
| [POS_DASHBOARD.md](POS_DASHBOARD.md) | Dashboard — tabs (Orders, Invoices, Estimates, Accounting, Templates), metrics |
| [POS_TEMPLATES.md](POS_TEMPLATES.md) | Template system — 3-step wizard, 6 doc types, LayoutBlock types, BlockStyle, `pg Client` direct pattern |
| [POS_USERS.md](POS_USERS.md) | POS user management — whitelist table, invite flow, env vars |
| [POS_VENDORS.md](POS_VENDORS.md) | Vendor management — UI exists in POS, no backend module yet |
| [POS_DISCOUNT_AND_PROMOTIONS_API.md](POS_DISCOUNT_AND_PROMOTIONS_API.md) | Ad-hoc discounts (`pos-discount`) — Draft Order Edit workflow, `target_type: "items"`, `posOverrideAdjustmentsWorkflow` |
| [POS_TRANSFER_API.md](POS_TRANSFER_API.md) | Force-transfer order to new customer — bypasses Medusa's native token-based flow |
| [POS_TAX_MODULE.md](POS_TAX_MODULE.md) | Custom Florida 7% tax provider — exemption logic (customer group or metadata), rate IDs hardcoded, shipping exempt |
| [SYSTEM_DEFAULTS_AND_NOTE_PRESETS.md](SYSTEM_DEFAULTS_AND_NOTE_PRESETS.md) | `system_defaults` table (dropdowns, payment methods, footer templates) + `note_presets` library — both auto-migrate |
| [DOCUMENT_NUMBERING_SYSTEM.md](DOCUMENT_NUMBERING_SYSTEM.md) | E-prefix (estimates via Medusa display_id) + S-prefix (orders via custom_order_seq) — original estimate number preserved in metadata |

---

## 📦 Checkout & Cart

| Document | Description |
|---|---|
| [CHECKOUT_PAYMENT_GUIDE.md](CHECKOUT_PAYMENT_GUIDE.md) | **Fast Checkout** (single POST, 2-3s) + Authorize.net Accept.js + Medusa v2 cart-to-order flow |
| [BRANDING_API.md](BRANDING_API.md) | `GET /store/branding` + `GET /pub/branding` — brand identity config for all frontends, MinIO logo URL |

---

## 🚚 Shipping

| Document | Description |
|---|---|
| [SHIPPING_GUIDE.md](SHIPPING_GUIDE.md) | All 6 providers — UPS Ground/NDA/2DA/3DS + flat-rate ground + store pickup; `ups-rate-cache.ts` singleton; box-packing algorithm |
| [UPS_SHIPPING_SYSTEM.md](UPS_SHIPPING_SYSTEM.md) | UPS deep-dive — `ups-rate-cache.ts` singleton (30s in-process cache, deduplication), box-packing long-items handling |
| [SHIPPING_SETTINGS_MODULE.md](SHIPPING_SETTINGS_MODULE.md) | `shipping-settings-module` — free-shipping threshold, regular price, long-item price, override UPS ground flag |
| [UBER_DIRECT_SHIPPING.md](UBER_DIRECT_SHIPPING.md) | Uber Direct provider (POS-only, fixed-price) — provider activo ✅, integración API de quotes pendiente 🔲; plan completo de implementación |

---

## 🔗 Frontend Integration

| Document | Description |
|---|---|
| [FRONTEND_INTEGRATION_GUIDE.md](FRONTEND_INTEGRATION_GUIDE.md) | Master guide for frontend devs — all API endpoints, auth patterns, CORS, env vars |
| [FRONTEND_CUSTOMER_API_GUIDE.md](FRONTEND_CUSTOMER_API_GUIDE.md) | Customer account APIs — profile, addresses, orders; fetch patterns |
| [FRONTEND_BREADCRUMBS_IMPLEMENTATION.md](FRONTEND_BREADCRUMBS_IMPLEMENTATION.md) | Category breadcrumbs via `parent_category` chain |

---

## 📊 Orders

| Document | Description |
|---|---|
| [ORDERS_DRAFT_ESTIMATES.md](ORDERS_DRAFT_ESTIMATES.md) | Draft orders & estimates — force endpoints, POS discount design, note presets, `setDocument()` BL link, totals fix |
| [ORDERS_SALES_UI.md](ORDERS_SALES_UI.md) | Admin UI for confirmed Sales Orders — filters, QB ref column, Show Cancelled toggle |

---

## 🚀 Deployment

| Document | Description |
|---|---|
| [DEPLOY_RAILWAY.md](DEPLOY_RAILWAY.md) | Railway deployment — pre-deploy checklist, env vars, common failures mapped to exact fixes |
| [DEPLOY_WORKER_MODE.md](DEPLOY_WORKER_MODE.md) | Worker mode — why `workerMode: "shared"` is non-negotiable; what breaks without it |
| [DEPLOY_PERFORMANCE.md](DEPLOY_PERFORMANCE.md) | Performance — Redis `keepAlive`/`pingInterval`, DB `min: 0` pool, startup optimization (60s → <30s) |

---

## 🛠️ Development

| Document | Description |
|---|---|
| [DEV_QUICKSTART.md](DEV_QUICKSTART.md) | Fastest path to a running local backend — consolidated from 3 setup guides |
| [DEV_LINTING.md](DEV_LINTING.md) | ESLint + TypeScript linting setup and rules |
| [DEV_QUERY_PATTERNS.md](DEV_QUERY_PATTERNS.md) | `remoteQuery` vs Knex — when to use each, tradeoffs, examples |
| [DEV_MEDUSA_AMOUNTS.md](DEV_MEDUSA_AMOUNTS.md) | Amounts in cents everywhere — exceptions (`shipping_settings` uses cents too); Medusa v2 major units |
| [DEV_MEDUSA_PATCHES.md](DEV_MEDUSA_PATCHES.md) | All patches in `backend/patches/` — tax-discount-aware, order totals bug, cart race condition, subscriber fix; applied via post-build.js |

---

## 🔧 Bug Fixes (FIXES/)

| Document | Description |
|---|---|
| [FIXES/batch-variant-price-sync-fix-feb-2026.md](FIXES/batch-variant-price-sync-fix-feb-2026.md) | Variant prices not updating in Meilisearch on bulk price update |
| [FIXES/checkout-currency-and-display-fixes-feb-2026.md](FIXES/checkout-currency-and-display-fixes-feb-2026.md) | Currency display issues at checkout |
| [FIXES/fast-checkout-architecture.md](FIXES/fast-checkout-architecture.md) | Checkout 10-15s → 2-3s via single endpoint + all deploy-related bugs |
| [FIXES/google-oauth-railway-cors-fix.md](FIXES/google-oauth-railway-cors-fix.md) | Railway CORS blocking Google OAuth callback |
| [FIXES/ups-province-format-fix-feb-2026.md](FIXES/ups-province-format-fix-feb-2026.md) | UPS province/state format fix for Canadian addresses |

---

## 📁 Not Indexed

- `README.md` — navigation guide for the docs directory
- `scripts/` — script organization reference (see workspace CLAUDE.md for script naming conventions)
