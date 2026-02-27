# 📘 QuickBooks Bridge API Reference for Medusa Integration

**Version:** 1.0 (Production)
**Base URL:** `http://<SERVER_IP>:3000/api`
**Auth Header:** `x-api-key: mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD`

---


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | API reference for the Medusa-facing endpoints of the QuickBooks Bridge service — covering all endpoints the Medusa backend calls to import customers, sync products, and verify QuickBooks connection status. |
| **Problemas que resuelve** | The bridge service exposes a REST API that Medusa uses to pull QuickBooks data. This reference documents every endpoint, its authentication requirements, request/response schemas, and error codes so the Medusa side can integrate correctly. |
| **Resultado esperado** | Backend developers can integrate any Medusa workflow with the QuickBooks Bridge using this reference, without needing to inspect the bridge's source code. |
| **Scripts Creados** | `import-customers-from-qb.ts` |

## 0. System Verification (Health Check)
Before sending heavy requests, verify the API is online.
*   **Endpoint:** `GET /health`
*   **Action:** Returns 200 OK if the Bridge NodeJS Service is running.
*   **Note:** This does NOT guarantee QuickBooks is open, only that the Bridge is listening.

**Response:**
```json
{
  "status": "healthy",
  "queueSize": 0
}
```

---

## 1. Product & Inventory Management

### Get Single Product Info (Read)
Retrieve price and stock.
*   **Strategy:** Use `FullName` (SKU) first to discover the ID. Once you have the `ListID`, always use that for future queries (it's faster).

**Option A: Find by SKU (First time)**
*   **Endpoint:** `GET /api/products?FullName=TSHIRT-001`

**Option B: Find by ID (Recommended)**
*   **Endpoint:** `GET /api/products?ListID=8000ABCD-12345678`

**Response:**
```json
{
  "ListID": "8000ABCD-12345678",
  "Name": "TSHIRT-001",
  "FullName": "TSHIRT-001",
  "SalesPrice": "25.00",
  "QuantityOnHand": "150"
}
```

### Update Inventory (Mass Sync)
Update stock quantities for a batch of products.
**Note:** This uses the `ItemInventoryMod` operation. currently supports modifying `QuantityOnHand`.
*   **Endpoint:** `POST /api/products/sync` (or `/api/sync/selective`)
*   **Payload:**
```json
{
  "items": [
    { "ListID": "8000ABCD-12345678", "quantity": 149 },
    { "ListID": "8000EFGH-90123456", "quantity": 50 }
  ]
}
```

---

## 2. Customer Management

### Create Customer
*   **Endpoint:** `POST /api/customers`
*   **Payload:**
```json
{
  "Name": "Juan Perez",
  "CompanyName": "Empresa S.A.",
  "Email": "juan@example.com",
  "Phone": "555-1234",
  "BillAddress": {
    "Addr1": "Calle 123",
    "City": "Miami",
    "City": "Miami",
    "State": "FL",
    "PostalCode": "33100"
  },
  "CustomerType": "Wholesale",       // Optional
  "PriceLevel": "Wholesale"  // Optional
}
```
**Response:** Returns `ListID` (e.g., `80009999-12345678`). **Store this ID.**

### Get Customer Info
*   **Endpoint:** `POST /api/customers` (Action: Query)
*   **Payload:**
```json
{
  "action": "query",
  "ListID": "80009999-12345678"
}
```

### 2.1 Customer Migration (Bulk Export)
For initial migration to Medusa V2, use the dedicated export script.

*   **Command:** `npx ts-node scripts/export_customers.ts`
*   **Output:** `scripts/customers_export.json`

**Data Points Mapped:**
*   `ListID` -> Medusa metadata `qb_list_id`
*   `FirstName`, `LastName` -> Customer Name
*   `Terms` -> Payment Terms (B2B)
*   `TaxCode` -> Tax Exemptions
*   `CreditLimit` -> Risk Management
*   `Billing/Shipping Address` -> Address Book

---

## 3. Order Processing Flow (The "Prepayment" Flow)

> **⚠️ IMPORTANT:** ALL operations below use `customerId` (QB ListID, e.g. `"8000004E-1342117388"`) to identify customers.
> This is more reliable than `customerName` which is ambiguous. The Bridge QBXML builders support both, but **always prefer `customerId`**.

### Step 1: Create Sales Order
Reserves stock but does not create accounting impact.
*   **Endpoint:** `POST /api/sales-orders`
*   **Payload:**
```json
{
  "customerId": "8000004E-1342117388",
  "templateRef": "Sales Order Original",
  "date": "2026-01-26",
  "items": [
    {
      "productId": "8000ABCD-12345678",
      "quantity": 1,
      "price": 25.00,
      "desc": "T-Shirt Red Size M"
    }
  ]
}
```
**Response (async):** Returns `operationId`. Poll `GET /api/sync/status/{operationId}` for `TxnID`. **Store `qb_so_txnid`.**

### Step 2: Receive Payment (Unapplied Credit)
High-volume E-commerce: Record the payment immediately as a Credit.
*   **Endpoint:** `POST /api/payments`
*   **Payload:**
```json
{
  "customerId": "8000004E-1342117388",
  "amount": 25.00,
  "paymentMethod": "Credit Card",
  "refNumber": "PAY-ord_01JFXYZ",
  "memo": "Web Order #1001",
  "autoApply": false,
  "depositAccount": "Undeposited Funds"
}
```
**Response (async):** Returns `operationId`. Poll for `txnId` + `refNumber`. **Store `qb_payment_txn_id` + `qb_payment_ref`.**

### Step 3: Create Invoice (Fulfillment)
When shipping, create the official Invoice linked to the Sales Order.
*   **Endpoint:** `POST /api/invoices`
*   **Payload (linked to SO):**
```json
{
  "customerId": "8000004E-1342117388",
  "date": "2026-02-26",
  "LinkToTxnID": "1BA799-1772123423"
}
```
**Response (async):** Returns `operationId`. Poll for `txnId` + `refNumber`. **Store `qb_invoice_txn_id` + `qb_invoice_ref`.**

### Step 4: Apply Payment to Invoice (Close the Loop)
Tell QuickBooks to use the Credit setup in Step 2 to pay the Invoice from Step 3.
*   **Endpoint:** `POST /api/payments`
*   **Payload:**
```json
{
  "customerId": "8000004E-1342117388",
  "amount": 25.00,
  "invoiceId": "3C-11223",
  "creditTxnId": "2B-67890"
}
```

---

## 5. Estimates (Draft Order Flow)

### 5.1 Create Estimate

**When**: A Draft Order is created in Medusa Admin.

*   **Endpoint:** `POST /api/estimates`
*   **Payload:**
```json
{
  "customerId": "8000004E-1342117388",
  "date": "2026-02-26",
  "items": [
    {
      "productId": "800019EA-1715274093",
      "quantity": 2,
      "price": 22.95,
      "desc": "EAP-AS1-8S — 8ft Aluminum Channel Silver"
    }
  ],
  "memo": "Draft Order #draft_01JFXYZ",
  "templateRef": "Custom Estimate",
  "poNumber": "PO-12345"
}
```

**Response (async — queued for Web Connector):**
```json
{
  "success": true,
  "operationId": "uuid-here",
  "message": "Estimate creation queued"
}
```

**Poll for result:** `GET /api/sync/status/{operationId}` (see Section 6).
The result contains `operation.txnId` + `operation.refNumber` → **Save as `qb_estimate_txn_id` + `qb_estimate_ref`** in draft order metadata.

### 5.2 Convert Estimate → Sales Order

**When**: A Draft Order is confirmed / converted to a real Order in Medusa.

> **IMPORTANT:** `items[]` IS required — pass the same items from the Estimate. QB links via `estimateTxnId` in the memo for traceability.

*   **Endpoint:** `POST /api/sales-orders/convert-from-estimate`
*   **Payload:**
```json
{
  "estimateTxnId": "1BA7A7-1772123940",
  "customerId": "8000004E-1342117388",
  "date": "2026-02-26",
  "items": [
    {
      "productId": "800019EA-1715274093",
      "quantity": 2,
      "desc": "EAP-AS1-8S 8ft Aluminum Channel Silver"
    }
  ],
  "memo": "From Estimate E18024525"
}
```

**Response (async):**
```json
{
  "success": true,
  "operationId": "uuid-here",
  "message": "Estimate → Sales Order conversion queued"
}
```

The result contains `operation.txnId` + `operation.refNumber` → **Save as `qb_sales_order_txn_id` + `qb_sales_order_ref`**.

### 5.3 Required Fields Reference

| Field | Estimate | Sales Order | Convert |
|-------|----------|-------------|---------|
| `customerId` OR `customerName` | ✅ | ✅ | ✅ |
| `items[]` | ✅ | ✅ | ❌ (from estimate) |
| `estimateTxnId` | — | — | ✅ |
| `date` | optional | optional | optional |
| `memo` | optional | optional | optional |
| `templateRef` | optional | optional | optional |
| `poNumber` | optional | optional | optional |
| `refNumber` | optional | optional | optional |

---

## 6. Async Operation Polling

All Bridge write operations are **asynchronous** — they are queued and processed via QuickBooks Web Connector (~1 min polling interval).

*   **Endpoint:** `GET /api/sync/status/{operationId}`

| Status | Meaning |
|--------|---------|
| `pending` | Queued, waiting for Web Connector |
| `processing` | Being sent to QuickBooks |
| `completed` | Success — check `result` field for TxnID |
| `failed` | Error — check `error` field |

**Typical wait time:** 1-2 minutes after submission.

---

## 7. Sales Receipt (Immediate Sale)
Alternative Flow: If NO inventory reservation is needed (Walk-in / POS).
*   **Endpoint:** `POST /api/sales-receipts`
*   **Payload:**
```json
{
  "customerName": "Unknown Customer",
  "templateRef": "Sales Receipt Ecopowerte",
  "items": [
    {
      "productId": "8000ABCD-12345678",
      "quantity": 1,
      "rate": 25.00
    }
  ],
  "paymentMethod": "Cash"
}
```

---

## 8. Troubleshooting (For Medusa Devs)

*   **Error 3140 (Invalid Reference):** You sent a `ListID` (Product or Customer) that doesn't exist in QB. Always sync IDs first.
*   **No Response / Timeout:** The Bridge might be blocked by a popup in QuickBooks. Retry logic should be exponential backoff.
*   **Fields:** Never send `&`, `<`, `>` in names. Use standard ASCII if possible (though Bridge has escaping logic).
*   **Async Results:** Remember all write operations return an `operationId`. You must poll `GET /api/sync/status/{operationId}` to get the actual TxnID.

**Generated by:** Auto-Integration Module  
**Date:** Jan 26, 2026  
**Updated:** Feb 26, 2026 — Added Estimates API (Section 5) and Async Polling (Section 6)

