# 📘 QuickBooks Bridge API Reference for Medusa Integration

**Version:** 1.0 (Production)
**Base URL:** `http://<SERVER_IP>:3000/api`
**Auth Header:** `x-api-key: mQb-7k9Pzx4RwN2vL8jT3bY6hF5nC1aD`

---

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

### Step 1: Create Sales Order
Reserves stock but does not create accounting impact.
*   **Endpoint:** `POST /api/sales-orders`
*   **Payload:**
```json
{
  "customerName": "Juan Perez",
  "templateRef": "Sales Order Original", // Controls the form template
  "date": "2026-01-26",
  "items": [
    {
      "productId": "8000ABCD-12345678", // ListID from Product Lookup
      "quantity": 1,
      "price": 25.00,
      "desc": "T-Shirt Red Size M"
    }
  ]
}
```
**Response:** Returns `TxnID` (e.g., `1A-12345`). **Store `qb_so_txnid`.**

### Step 2: Receive Payment (Unapplied Credit)
High-volume E-commerce: Record the payment immediately as a Credit.
*   **Endpoint:** `POST /api/payments`
*   **Payload:**
```json
{
  "customerName": "Juan Perez",
  "amount": "25.00",
  "paymentMethod": "Cash", // 'Visa', 'MasterCard', etc.
  "memo": "Web Order #1001",
  "autoApply": false  // CRITICAL: Tells QB to keep it as open credit
}
```
**Response:** Returns `TxnID` (e.g., `2B-67890`). **Store `qb_payment_txnid`.**

### Step 3: Create Invoice (Fulfillment)
When shipping, create the official Invoice linked to the Sales Order.
*   **Endpoint:** `POST /api/invoices`
*   **Payload:**
```json
{
  "customerName": "Juan Perez",
  "templateRef": "Invoice Ecopowertech", // Controls the form template
  "LinkToTxnID": "1A-12345" // The Sales Order TxnID
}
```
**Response:** Returns `TxnID` (e.g., `3C-11223`). **Store `qb_invoice_txnid`.**

### Step 4: Apply Payment to Invoice (Close the Loop)
Tell QuickBooks to use the Credit setup in Step 2 to pay the Invoice from Step 3.
*   **Endpoint:** `POST /api/payments`
*   **Payload:**
```json
{
  "customerName": "Juan Perez",
  "amount": "25.00",        // Amount to apply
  "invoiceId": "3C-11223",  // Invoice TxnID
  "creditTxnId": "2B-67890" // Payment TxnID (The Credit)
}
```

---

## 4. Sales Receipt (Immediate Sale)
Alternative Flow: If NO inventory reservation is needed (Walk-in / POS).
*   **Endpoint:** `POST /api/sales-receipts`
*   **Payload:**
```json
{
  "customerName": "Unknown Customer", // Or generic "Web Customer"
  "templateRef": "Sales Receipt Ecopowerte", // Controls the form template
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

## 5. Troubleshooting (For Medusa Devs)

*   **Error 3140 (Invalid Reference):** You sent a `ListID` (Product or Customer) that doesn't exist in QB. Always sync IDs first.
*   **No Response / Timeout:** The Bridge might be blocked by a popup in QuickBooks. Retry logic should be exponential backoff.
*   **Fields:** Never send `&`, `<`, `>` in names. Use standard ASCII if possible (though Bridge has escaping logic).

**Generated by:** Auto-Integration Module
**Date:** Jan 26, 2026
