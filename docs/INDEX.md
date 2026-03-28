---
**Purpose:** Master index and navigation guide for all backend documentation — organized by category (Auth, Admin Panel, Categories, Products, QuickBooks, Deployment, etc.) with one-line descriptions to help developers find the right document quickly.

**Solves:** With 70+ backend docs, finding the right document without an index is time-consuming. This index is the entry point for anyone starting work on any backend area of EcoPowerTech.

**Expected Result:** Any developer can open this index, identify the most relevant doc for their task, and navigate directly to it. The index is kept up-to-date as new docs are added.

---

# Backend Documentation Index

> **Last Updated:** March 2026 | **Total Docs:** 75+

---

## 🔐 Authentication

| Document | Description |
|---|---|
| [AUTH_DOCUMENTATION_INDEX.md](AUTH_DOCUMENTATION_INDEX.md) | **Start here** — navigation index for all auth docs |
| [AUTHENTICATION_COMPLETE_GUIDE.md](AUTHENTICATION_COMPLETE_GUIDE.md) | Master guide: 3-case registration, login, password reset, Google OAuth |
| [AUTHENTICATION_BACKEND_API_SPEC.md](AUTHENTICATION_BACKEND_API_SPEC.md) | Contract-level API spec: endpoints, request/response schemas, DB schema |
| [AUTHENTICATION_VERIFICATION_WALKTHROUGH.md](AUTHENTICATION_VERIFICATION_WALKTHROUGH.md) | E2E test results & bug fixes found during production verification |
| [CUSTOMER_AUTH_3_CASES_COMPLETE_GUIDE.md](CUSTOMER_AUTH_3_CASES_COMPLETE_GUIDE.md) | Full auth guide in Spanish — 3 registration cases, legacy QuickBooks flow |
| [FRONTEND_AUTH_INTEGRATION_ASTRO_GUIDE.md](FRONTEND_AUTH_INTEGRATION_ASTRO_GUIDE.md) | Copy-paste Astro components for registration, activation, login |
| [FRONTEND_TO_BACKEND_AUTH_API_CALLS.md](FRONTEND_TO_BACKEND_AUTH_API_CALLS.md) | Audit trail: every auth API call the frontend makes |
| [ADDRESS_MANAGEMENT_BACKEND_GUIDE.md](ADDRESS_MANAGEMENT_BACKEND_GUIDE.md) | Custom route for address updates + default-swap logic |

---

## 👤 Google OAuth

| Document | Description |
|---|---|
| [GOOGLE_OAUTH_COMPLETE_GUIDE.md](GOOGLE_OAUTH_COMPLETE_GUIDE.md) | Full Google OAuth implementation — Cloud Console + Medusa config |
| [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md) | Backend configuration only (`medusa-config.ts` + env vars) |
| [GOOGLE_OAUTH_QUICK_REFERENCE.md](GOOGLE_OAUTH_QUICK_REFERENCE.md) | Quick lookup: env vars, redirect URIs, common mistakes |
| [FIXES/google-oauth-railway-cors-fix.md](FIXES/google-oauth-railway-cors-fix.md) | Fix: Railway CORS blocking OAuth callback |

---

## 🖥️ Admin Panel — Pages & Widgets

> **Concept:** Pages are enhanced replacements for native Medusa pages (with Meilisearch). Widgets are custom additions not found in vanilla Medusa.

| Document | Description |
|---|---|
| [ADMIN_PANEL_ATTRIBUTES_MANAGEMENT_PAGE.md](ADMIN_PANEL_ATTRIBUTES_MANAGEMENT_PAGE.md) | Full Attributes Management page — AttributeSets, Keys, Values, product linking |
| [ADMIN_PANEL_PRODUCT_DETAIL_ATTRIBUTES_WIDGET.md](ADMIN_PANEL_PRODUCT_DETAIL_ATTRIBUTES_WIDGET.md) | Widget on product detail: displays/edits product-level attributes inline |
| [ADMIN_PANEL_PRODUCT_ATTRIBUTES_MODAL_UX_AND_SAVE_LOGIC.md](ADMIN_PANEL_PRODUCT_ATTRIBUTES_MODAL_UX_AND_SAVE_LOGIC.md) | Modal UX & save logic for editing attribute values on a product |
| [ADMIN_PANEL_CATEGORY_DETAIL_FILTERS_WIDGET.md](ADMIN_PANEL_CATEGORY_DETAIL_FILTERS_WIDGET.md) | Widget on category detail: filter config editor (active/available filters) |
| [ADMIN_SETUP_CUSTOMER_PRICING.md](ADMIN_SETUP_CUSTOMER_PRICING.md) | How to set up Wholesale vs. Retail price lists in the Admin Panel |
| [QUICKBOOKS_ADMIN_DASHBOARD.md](QUICKBOOKS_ADMIN_DASHBOARD.md) | Custom dashboard page: QuickBooks sync status & manual trigger controls |

---

## 🛍️ Products & Variants

| Document | Description |
|---|---|
| [PRODUCT_ATTRIBUTES_ARCHITECTURE.md](PRODUCT_ATTRIBUTES_ARCHITECTURE.md) | Full architecture: AttributeSet → Key → Value module design & links |
| [DYNAMIC_VARIANTS_SYSTEM.md](DYNAMIC_VARIANTS_SYSTEM.md) | Attribute-driven variant selectors (color swatches, size dropdowns) |
| [PRODUCT_SEARCH_ADVANCED_AUTO_SYNC_ARCHITECTURE.md](PRODUCT_SEARCH_ADVANCED_AUTO_SYNC_ARCHITECTURE.md) | Advanced Products page with Meilisearch + 3-layer auto-sync |
| [PRODUCT_IMAGES_AND_DYNAMIC_PRICING.md](PRODUCT_IMAGES_AND_DYNAMIC_PRICING.md) | Fix: image array field + pricing context for Medusa v2 |
| [DYNAMIC_PRICING_ENDPOINT.md](DYNAMIC_PRICING_ENDPOINT.md) | Step-by-step guide (ES) — fetch prices, major units, customer groups |
| [GETTING_PRODUCT_PRICES.md](GETTING_PRODUCT_PRICES.md) | `calculated_price` vs `amount`, region context, v2 major units |
| [LONG_DESCRIPTION_GUIDE.md](LONG_DESCRIPTION_GUIDE.md) | How to fetch and render `product.metadata.long_description` as HTML |

---

## 🗂️ Categories & Filters

| Document | Description |
|---|---|
| [CATEGORY_FILTERS.md](CATEGORY_FILTERS.md) | Complete system guide: data model, API, frontend, sync, soft-delete |
| [CATEGORY_FILTERS_NUCLEAR_SYNC.md](CATEGORY_FILTERS_NUCLEAR_SYNC.md) | Nuclear sync algorithm — from 7,936ms to ~225ms for 125+ descendants |
| [CATEGORY_FILTERS_SOFT_DELETE_SECTION.md](CATEGORY_FILTERS_SOFT_DELETE_SECTION.md) | Critical fix: exclude soft-deleted links from filter generation |
| [CATEGORY_SORTING.md](CATEGORY_SORTING.md) | Drag-and-drop subcategory/product ordering with metadata |
| [CATEGORY_IMAGES_TECHNICAL.md](CATEGORY_IMAGES_TECHNICAL.md) | Admin API limitation + metadata workaround for category images |
| [CATEGORY_PRODUCTS_ENDPOINT_OPTIMIZATION.md](CATEGORY_PRODUCTS_ENDPOINT_OPTIMIZATION.md) | Knex batch pricing + SQL optimizations for the products endpoint |

---

## 🔍 Meilisearch Auto-Sync

| Document | Description |
|---|---|
| [MEILISEARCH_AUTO_SYNC_COMPLETE_GUIDE.md](MEILISEARCH_AUTO_SYNC_COMPLETE_GUIDE.md) | Full guide: all indexes, 3-layer sync architecture, batch re-index scripts |
| [MEILISEARCH_MIDDLEWARE_SYSTEM_2026.md](MEILISEARCH_MIDDLEWARE_SYSTEM_2026.md) | Feb 2026: why middleware replaced subscribers as sync trigger |
| [CUSTOMERS_ADVANCED_AUTO_SYNC_ARCHITECTURE.md](CUSTOMERS_ADVANCED_AUTO_SYNC_ARCHITECTURE.md) | Advanced Customers page — Meilisearch + 3-layer auto-sync |
| [INVENTORY_ADVANCED_AUTO_SYNC_ARCHITECTURE.md](INVENTORY_ADVANCED_AUTO_SYNC_ARCHITECTURE.md) | Advanced Inventory page — Meilisearch + 3-layer auto-sync |
| [FIXES/batch-variant-price-sync-fix-feb-2026.md](FIXES/batch-variant-price-sync-fix-feb-2026.md) | Fix: variant prices not updating in Meilisearch on bulk price update |

---

## 🖼️ Storage & Images

| Document | Description |
|---|---|
| [MINIO_STORAGE_IMPLEMENTATION.md](MINIO_STORAGE_IMPLEMENTATION.md) | MinIO S3 plugin setup, bucket policies, Railway persistence |
| [IMAGE_MANAGEMENT_MINIO_SYSTEM.md](IMAGE_MANAGEMENT_MINIO_SYSTEM.md) | Full image management: folder routing, media library, upload API |

---

## 🔗 Frontend Integration Guides

| Document | Description |
|---|---|
| [FRONTEND_INTEGRATION_GUIDE.md](FRONTEND_INTEGRATION_GUIDE.md) | Master: all API endpoints, auth patterns, CORS, env vars for frontend devs |
| [FRONTEND_CUSTOMER_API_GUIDE.md](FRONTEND_CUSTOMER_API_GUIDE.md) | Customer account APIs: profile, addresses, orders — fetch patterns |
| [FRONTEND_BREADCRUMBS_IMPLEMENTATION.md](FRONTEND_BREADCRUMBS_IMPLEMENTATION.md) | Category breadcrumbs via `parent_category` chain (deprecated metadata approach) |

---

## 📦 Checkout & Cart

| Document | Description |
|---|---|
| [CHECKOUT_PAYMENT_IMPLEMENTATION_GUIDE.md](CHECKOUT_PAYMENT_IMPLEMENTATION_GUIDE.md) | **Fast Checkout** (single POST) + Authorize.net Accept.js + Medusa v2 — cart to order |
| [CART_RACE_CONDITION_FIX.md](CART_RACE_CONDITION_FIX.md) | Fix: qty debouncing to prevent stale cart updates on rapid clicks |
| [SHIPPING_IMPLEMENTATION_GUIDE.md](SHIPPING_IMPLEMENTATION_GUIDE.md) | UPS real-time rates + flat-rate + store pickup + box packing logic |
| [ADMIN_SETUP_CUSTOMER_PRICING.md](ADMIN_SETUP_CUSTOMER_PRICING.md) | Setting up price lists in Admin (Wholesale / Retail) |
| [FIXES/fast-checkout-architecture.md](FIXES/fast-checkout-architecture.md) | Fix: checkout 10-15s → 2-3s via single Medusa endpoint + all deploy bugs |

---

## 🔌 QuickBooks Bridge

| Document | Description |
|---|---|
| [QUICKBOOKS_BRIDGE_INTEGRATION_BIBLE.md](QUICKBOOKS_BRIDGE_INTEGRATION_BIBLE.md) | **Master reference (ES)** — architecture, data mapping, auth, sync, operations |
| [QUICKBOOKS_BRIDGE_MEDUSA_API_REFERENCE.md](QUICKBOOKS_BRIDGE_MEDUSA_API_REFERENCE.md) | API endpoints the Medusa backend calls on the Bridge service |
| [QUICKBOOKS_BRIDGE_NODE_V12_COMPATIBILITY.md](QUICKBOOKS_BRIDGE_NODE_V12_COMPATIBILITY.md) | Node.js v12 compatibility fixes for Windows Server 2008 |
| [QUICKBOOKS_CUSTOMER_IMPORT.md](QUICKBOOKS_CUSTOMER_IMPORT.md) | Customer import: field mapping, deduplication, verification |
| [QB_SUBSCRIBERS_REFERENCE.md](QB_SUBSCRIBERS_REFERENCE.md) | Reference for all QB event subscribers — handlers, idempotency, metadata keys |
| [QB_PIPELINE_ARCHITECTURE.md](QB_PIPELINE_ARCHITECTURE.md) | **Pipeline tracking system** — `qb_order_pipeline` table, consolidator cron, EditSequence cache, SR guard |
| [QB_DOCUMENT_FLOW_REDESIGN.md](QB_DOCUMENT_FLOW_REDESIGN.md) | Decision tree: which QB document gets created for each order type (Web/POS/Estimate) |
| [POS_ASYNC_QB_SYNC_ARCHITECTURE.md](POS_ASYNC_QB_SYNC_ARCHITECTURE.md) | POS async sync — 1-hour delay, cron jobs, race condition guard |
| [DRAFT_ORDER_ADVANCED_UI.md](DRAFT_ORDER_ADVANCED_UI.md) | **Complete guide** to the Advanced Draft Orders page + QB Estimate lifecycle |
| [SALES_ORDERS_UI.md](SALES_ORDERS_UI.md) | Admin UI for confirmed Sales Orders: filters, QB ref column, Show Cancelled |
| [POS_INVOICE.md](POS_INVOICE.md) | Admin UI for Invoices: fulfilled orders with QB Invoice tracking |

---

## 🛒 POS (Point of Sale)

| Document | Description |
|---|---|
| [POS_ARCHITECTURE.md](POS_ARCHITECTURE.md) | **Master guide** — Sales Channels, QB Sales Receipt flow, Credit Ledger, multi-invoice Receive Payment |
| [POS_TEMPLATES.md](POS_TEMPLATES.md) | **Template System** — 3-step wizard (Fields → Layout → Preview), LayoutBlock types, BlockStyle, clamping, migration, save sync, and guide to building new template pages |
| [POS_ESTIMATES.md](POS_ESTIMATES.md) | Estimate module — create/edit/convert, QB sync, PDF/print flow |
| [POS_ORDERS.md](POS_ORDERS.md) | Sales Orders module — order editing, payments, discounts |
| [POS_CUSTOMERS.md](POS_CUSTOMERS.md) | Customer module — search, profile, balance/credit |
| [POS_INVENTORY.md](POS_INVENTORY.md) | Inventory module — stock levels, location management |
| [POS_AUTH.md](POS_AUTH.md) | POS authentication — staff vs admin roles |
| [POS_CAPTURE_PAYMENT.md](POS_CAPTURE_PAYMENT.md) | Payment capture flow |
| [POS_DASHBOARD.md](POS_DASHBOARD.md) | Dashboard overview |
| [POS_USERS.md](POS_USERS.md) | User management |
| [POS_VENDORS.md](POS_VENDORS.md) | Vendor management |
| [POS_QUICKBOOKS.md](POS_QUICKBOOKS.md) | QuickBooks integration from POS side |

---

## 🚀 Deployment

| Document | Description |
|---|---|
| [RAILWAY_DEPLOYMENT_CHECKLIST.md](RAILWAY_DEPLOYMENT_CHECKLIST.md) | Pre-deploy env vars checklist + service configuration |
| [RAILWAY_DEPLOYMENT_TROUBLESHOOTING.md](RAILWAY_DEPLOYMENT_TROUBLESHOOTING.md) | Common Railway deploy failures mapped to exact fixes |
| [RAILWAY_STARTUP_OPTIMIZATION.md](RAILWAY_STARTUP_OPTIMIZATION.md) | Cold-start optimization — from 60s to under 30s |
| [NEXT_STEPS_DEPLOYMENT.md](NEXT_STEPS_DEPLOYMENT.md) | Post-development deployment checklist for Railway |
| [PRERENDER_CONFIGURATION.md](PRERENDER_CONFIGURATION.md) | Backend endpoints required for Astro `getStaticPaths` at build time |

---

## ⚡ Performance & Architecture

| Document | Description |
|---|---|
| [PERFORMANCE_OPTIMIZATION_REDIS_AND_DATABASE.md](PERFORMANCE_OPTIMIZATION_REDIS_AND_DATABASE.md) | Redis cache + DB query optimization → sub-400ms responses |
| [QUERY_PATTERNS_REFERENCE.md](QUERY_PATTERNS_REFERENCE.md) | `remoteQuery` vs Knex — when to use each, tradeoffs, examples |
| [MEDUSA_V2_SUBSCRIBER_BUG_AND_MIDDLEWARE_FIX.md](MEDUSA_V2_SUBSCRIBER_BUG_AND_MIDDLEWARE_FIX.md) | Critical Medusa v2 bug: silent subscriber failures + middleware fix |
| [WHY_WORKER_IS_NEEDED.md](WHY_WORKER_IS_NEEDED.md) | Why Medusa Worker is non-negotiable — what breaks without it |

---

## 📧 Notifications

| Document | Description |
|---|---|
| [EMAIL_TEMPLATE_IMPROVEMENTS.md](EMAIL_TEMPLATE_IMPROVEMENTS.md) | Activation & password reset email redesign + SendGrid template IDs |

---

## 🛠️ Setup & Development

| Document | Description |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | Fastest path to a running local backend (new machine) |
| [LOCAL_INSTALLATION.md](LOCAL_INSTALLATION.md) | Full local setup guide with all integrations |
| [SETUP.md](SETUP.md) | Home-PC specific setup (ES) |
| [LINTING_GUIDE.md](LINTING_GUIDE.md) | ESLint + TypeScript linting setup and rules |
| [NPM_TO_YARN_MIGRATION.md](NPM_TO_YARN_MIGRATION.md) | Why Yarn replaced npm and migration steps |

---

## 📁 Files Not Indexed

- `authentication_walkthrough.md.deprecated` — superseded by AUTHENTICATION_VERIFICATION_WALKTHROUGH.md
- `notebooklm-formatting-guide.md` — formatting reference for NotebookLM (not backend docs)
- `README.md` — navigation for the auth subdirectory docs
