# 📘 QuickBooks Bridge API Reference for Medusa Integration

**Version:** 2.1 (Production)
**Base URL:** `https://ecopower-qb.loca.lt/api`
**Auth Header:** `x-api-key: $QB_API_KEY`
**QBXML Version:** `10.0` (required for Inventory Site support)
**Last Updated:** Feb 27, 2026

---

## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | API reference for the Medusa-facing endpoints of the QuickBooks Bridge service — covering all endpoints the Medusa backend calls to sync orders, customers, products, and payments. |
| **Problemas que resuelve** | The bridge service exposes a REST API that Medusa uses to create QB documents. This reference documents every endpoint, request/response schemas, and error codes so the Medusa side can integrate correctly. |
| **Resultado esperado** | Backend developers can integrate any Medusa workflow with the QuickBooks Bridge using this reference, without needing to inspect the bridge's source code. |
| **Scripts Creados** | `import-customers-from-qb.ts` |

---

## 0. System Verification

```bash
GET /health
```
Returns `200 OK` if the Bridge is running. Does **not** guarantee QuickBooks is open.

```json
{ "status": "healthy", "queueSize": 0 }
```

---

## 1. Async Operation Pattern

All write endpoints (`POST`) are **async** — they return an `operationId` immediately and process via QBWC on the next sync cycle (every ~60s).

**Queue an operation:**
```json
{ "success": true, "data": { "operationId": "50643fe7-2a39-4ebc-86d6-6c8e7a2e101a" } }
```

**Poll for result:**
```bash
GET /api/sync/status/{operationId}
```
```json
{
  "success": true,
  "operation": {
    "status": "completed",          // "pending" | "processing" | "completed" | "failed"
    "txnId": "1BA983-1772153827",   // Internal QB ID — use for cross-doc references
    "refNumber": "E18024535"        // Human-readable — visible in QB UI
  }
}
```

**Polling Strategy:**
- Poll every **20 seconds**
- Up to **20 attempts** (max ~7 min wait)
- On `pending`/`processing`: keep polling
- On `completed`: read `txnId` + `refNumber` — **both must be saved**
- On `failed`: read `error`, handle accordingly

> **Always poll for `txnId`** before chaining operations (e.g., converting Estimate → SO requires the Estimate `txnId`).

---

## 2. Product & Inventory Management

### Get Product Info
```bash
GET /api/products?FullName=EAP-AS1-8S   # First time — find by SKU
GET /api/products?ListID=800019EA-1715274093  # Recommended — faster
```
```json
{
  "ListID": "800019EA-1715274093",
  "Name": "EAP-AS1-8S",
  "SalesPrice": "24.50",
  "QuantityOnHand": "89"
}
```

### Update Inventory (Bulk Sync)
```bash
POST /api/products/sync
```
```json
{
  "items": [
    { "ListID": "800019EA-1715274093", "quantity": 88 },
    { "ListID": "8000EFGH-90123456", "quantity": 50 }
  ]
}
```

---

## 3. Customer Management

### Create Customer
```bash
POST /api/customers
```
```json
{
  "Name": "Alejandro Vargas #4E1342",
  "CompanyName": "EcoPowerTech Inc.",
  "Email": "alejandro@ecopowertech.com",
  "Phone": "786-123-4561",
  "BillAddress": {
    "Addr1": "2760 NW 84th Street",
    "City": "Hialeah",
    "State": "FL",
    "PostalCode": "33016"
  },
  "CustomerType": "Wholesale"
}
```
**Response:** `{ "ListID": "8000004E-1342117388" }` — **Store this as `qb_list_id` in Medusa customer metadata.**

### Check if Customer Exists
```bash
GET /api/customers?ListID=8000004E-1342117388
```

### Customer Migration (Bulk Export)
For initial migration of QB customers to Medusa V2.

*   **Command (on Windows server):** `npx ts-node scripts/export_customers.ts`
*   **Output:** `scripts/customers_export.json`

**Data Points Mapped:**
*   `ListID` → Medusa metadata `qb_list_id`
*   `FirstName`, `LastName` → Customer Name
*   `Terms` → Payment Terms (B2B)
*   `TaxCode` → Tax Exemptions
*   `CreditLimit` → Risk Management
*   `Billing/Shipping Address` → Address Book

---

## 4. Estimates (Draft Orders / Quotes)

### Create Estimate
```bash
POST /api/estimates
```
```json
{
  "customerId": "8000004E-1342117388",
  "date": "2026-02-26",
  "salesTaxCode": "Sale Tax 7%",
  "items": [
    {
      "productId": "800019EA-1715274093",
      "quantity": 2,
      "price": 19.99,
      "desc": "EAP-AS1-8S (SKU-001)"
    }
  ],
  "memo": "Medusa Draft #draft_01JXXX"
}
```

**After polling** — save in Medusa draft order metadata:
```
operation.txnId      →  metadata.qb_estimate_txn_id  (e.g. "1BA7A7-1772123940")
operation.refNumber  →  metadata.qb_estimate_ref      (e.g. "E18024527")
```

### Pricing & Tax Notes — ⚠️ CRITICAL

#### Price: Always use `price` (sends as `<Amount>`, not `<Rate>`)
The Bridge sends `<Amount>` = `quantity × price` directly in QBXML. This **bypasses QuickBooks' UOM conversion factors**.

| Field | QBXML Tag | Behavior |
|-------|-----------|----------|
| `price` | `<Amount>qty×price</Amount>` | ✅ Exact amount, ignores UOM |
| *(omit price)* | *(none)* | QB uses product's Sales Price |

> **Why Amount and not Rate?** Products with UOM Sets (e.g., "By the each") store an internal conversion factor. Sending `<Rate>19.99</Rate>` gets multiplied by that factor (e.g., 7.4×). Sending `<Amount>39.98</Amount>` is used as-is.

#### Tax: Use `salesTaxCode` or `taxExempt`

| Payload field | QB result |
|--------------|-----------|
| `salesTaxCode: "Sale Tax 7%"` | Miami-Dade 7% tax |
| `salesTaxCode: "Sale Tax 6%"` | Broward 6% tax |
| `salesTaxCode: "Exempt"` | $0 tax (exempt) |
| `taxExempt: true` | Shorthand for `Exempt` |
| *(omit both)* | QB uses customer's default tax code |

The QB field used is `<ItemSalesTaxRef>` in the document header.
> ⚠️ **Never use `<CustomerSalesTaxCodeRef>`** — that's for tax codes, not items. The correct element is `<ItemSalesTaxRef>`.

### Modify Estimate
```bash
PUT /api/estimates/{txnId}
```
> The bridge automatically re-queries the EditSequence before modifying. No need to store EditSequence in Medusa.

```json
{
  "items": [
    {
      "TxnLineID": "1BAE30-1772237128",
      "productId": "800019EA-1715274093",
      "quantity": 3,
      "price": 42.99
    }
  ],
  "memo": "Updated Draft Order #draft_01JFXYZ"
}
```

---

## 5. Sales Orders

### Create Sales Order
```bash
POST /api/sales-orders
```
```json
{
  "customerId": "8000004E-1342117388",
  "date": "2026-02-26",
  "salesTaxCode": "Sale Tax 7%",
  "memo": "From Estimate E18024527",
  "items": [
    {
      "productId": "800019EA-1715274093",
      "quantity": 2,
      "price": 19.99,
      "desc": "EAP-AS1-8S (SKU-001)",
      "siteId": "80000001-1331053531"
    }
  ]
}
```

> **`siteId`** — QB Inventory Site ListID. Required for QB Enterprise to deduct inventory from the correct warehouse.
> Default (if omitted): `80000001-1331053531` (Principal Warehouse)
>
> | ListID | Name |
> |--------|------|
> | `80000001-1331053531` | Principal Warehouse (default) |
> | `80000002-1331055182` | Drop Ship |
>
> **Memo:** Use the Estimate RefNumber (e.g. `"From Estimate E18024527"`), not the TxnID — your team sees RefNumbers in QB Desktop.

**After polling** — save:
```
operation.txnId      →  metadata.qb_sales_order_txn_id  (e.g. "1BA799-1772123423")
operation.refNumber  →  metadata.qb_sales_order_ref     (e.g. "6139")
```

### Convert Estimate → Sales Order
```bash
POST /api/sales-orders/convert-from-estimate
```
```json
{
  "estimateTxnId": "1BA983-1772153827",
  "customerId": "8000004E-1342117388",
  "date": "2026-02-26",
  "salesTaxCode": "Sale Tax 7%",
  "items": [
    {
      "productId": "800019EA-1715274093",
      "quantity": 2,
      "price": 19.99
    }
  ],
  "memo": "From Draft #draft_01JXXX"
}
```
> ⚠️ QB does **not** auto-copy items from the Estimate. You **must** pass `items[]` again.

---

## 6. Payments

### Receive Payment (Unapplied Credit — E-commerce Flow)
```bash
POST /api/payments
```
```json
{
  "customerId": "8000004E-1342117388",
  "amount": "39.98",
  "paymentMethod": "Visa",
  "memo": "Medusa Order #1023",
  "refNumber": "PAY-ord_01JXXX",
  "autoApply": false
}
```
> `autoApply: false` keeps payment as an **open credit** until manually applied to an invoice. Use for e-commerce pre-payments.

**After polling** — save:
```
operation.txnId      →  metadata.qb_payment_txn_id
operation.refNumber  →  metadata.qb_payment_ref
```

### Apply Credit to Invoice
```bash
POST /api/payments
```
```json
{
  "customerId": "8000004E-1342117388",
  "amount": "39.98",
  "invoiceId": "3C-11223",
  "creditTxnId": "2B-67890"
}
```

---

## 7. Invoices

### Create Invoice (Linked to Sales Order)
```bash
POST /api/invoices
```
```json
{
  "customerId": "8000004E-1342117388",
  "LinkToTxnID": "1BA799-1772123423",
  "soRefNumber": "6139",
  "memo": "Shipped — Medusa Order #1023"
}
```
> `LinkToTxnID` = the Sales Order `txnId` from Step 5.
> `soRefNumber` — auto-generates memo: `"From SO #6139"` if no `memo` is passed.

**After polling** — save:
```
operation.txnId      →  metadata.qb_invoice_txn_id
operation.refNumber  →  metadata.qb_invoice_ref
```

---

## 8. Order Flow Summary

```
[ORDER PLACED]
  → POST /api/sales-orders   → { operationId } → poll → { txnId: "SO-xxx", refNumber: "6139" }

[PAYMENT CAPTURED]
  → POST /api/payments (autoApply:false)  → { operationId } → poll → { txnId: "PAY-xxx" }

[FULFILLMENT CREATED]
  → POST /api/invoices (LinkToTxnID: SO txnId)  → { operationId } → poll → { txnId: "INV-xxx" }
  → POST /api/payments (invoiceId + creditTxnId)  → applies the credit to close the loop
```

---

## 9. Metadata to Store in Medusa

```typescript
// Draft Order metadata
metadata.qb_estimate_txn_id = "1BA7A7-1772123940"   // for API calls
metadata.qb_estimate_ref    = "E18024527"            // visible in QB, for cross-reference

// Order metadata
metadata.qb_sales_order_txn_id = "1BA799-1772123423"
metadata.qb_sales_order_ref    = "6139"
metadata.qb_invoice_txn_id     = "..."
metadata.qb_invoice_ref        = "..."
metadata.qb_payment_txn_id     = "..."
metadata.qb_payment_ref        = "..."

// Customer metadata
metadata.qb_list_id = "8000004E-1342117388"
```

> **`refNumber`** is the number your team sees in QuickBooks (e.g. Estimate `E18024527`, Sales Order `6139`).
> **`txnId`** is the internal QB ID used for all API calls (MOD, query, link).
> Store both — `refNumber` for human cross-reference, `txnId` for API operations.

---

## 10. Field Reference

| Field | Type | Where Used | Description |
|-------|------|------------|-------------|
| `customerId` | string | All | QB Customer ListID (e.g. `8000004E-1342117388`) |
| `customerName` | string | All | Fallback — QB FullName (e.g. `Alejandro Vargas`) |
| `items[].productId` | string | EST, SO, INV | QB Item ListID (e.g. `800019EA-1715274093`) |
| `items[].productName` | string | EST, SO, INV | Fallback — QB Item FullName (e.g. `EAP-AS1-8S`) |
| `items[].quantity` | number | EST, SO, INV | Quantity |
| `items[].price` | number | EST, SO, INV | Unit price — bridge sends `Amount = price × qty` to QB |
| `items[].desc` | string | EST, SO, INV | Line description |
| `items[].siteId` | string | **SO, INV** | QB Inventory Site ListID — **required for inventory deduction** |
| `date` | string | All | Transaction date `YYYY-MM-DD` |
| `memo` | string | All | Free text memo — use RefNumbers, not TxnIDs |
| `salesTaxCode` | string | EST, SO | Tax item name (e.g. `"Sale Tax 7%"`, `"Exempt"`) |
| `taxExempt` | boolean | EST, SO | Shorthand for `salesTaxCode: "Exempt"` |
| `soRefNumber` | string | INV | SO RefNumber for auto-memo (`"From SO #6139"`) |
| `refNumber` | string | All | Custom reference number for the document |
| `poNumber` | string | EST, SO | Purchase order number |
| `LinkToTxnID` | string | INV | TxnID of SO to link invoice to |
| `estimateTxnId` | string | SO (convert) | TxnID of estimate being converted |
| `autoApply` | boolean | PAY | `false` = open credit, `true` = auto-apply to oldest invoice |

> **Always use `customerId` and `productId` (ListIDs) over name-based references.** ListIDs are permanent; names can change.

---

## 11. Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `0x80040400` XML parse error | Invalid field order in QBXML | `InventorySiteRef` must come **after** `Amount`/`Rate` in line items |
| Error 3140 Invalid Reference | `ListID` or site name doesn't exist in QB | Use `siteId` (ListID) not site name — names can have typos in QB |
| Price multiplied by ~7.4× | Sending `<Rate>` with UOM set product | Use `<Amount>` instead (price × qty) — bridge does this automatically |
| No Response / Timeout | QB popup blocking QBWC | Dismiss popup; retry; exponential backoff |
| `status: pending` forever | QBWC not running or QB not open | Check QB Web Connector app on Windows |
| WC stuck at 20% | Stale pending ops in queue | Delete `queue-state.json` and restart bridge |
| Error 3070 String too long | `RefNumber` exceeds 11 characters | Omit `RefNumber` (QB auto-assigns) or shorten to ≤11 chars |

---

## 12. Environment Variables (Bridge)

| Variable | Example | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Bridge HTTP port |
| `API_KEY` | `mQb-7k9Pzx4...` | Auth key for all requests |
| `TUNNEL_SUBDOMAIN` | `ecopower-qb` | localtunnel/Cloudflare subdomain |

---

**Generated by:** Medusa-QB Integration Team
**Date:** Jan 26, 2026
**Updated:** Feb 27, 2026 — v2.1: Added salesTaxCode, taxExempt, Modify Estimate, convert-from-estimate fix (items[] required), autoApply, full troubleshooting table, inventory site rules, metadata section.
