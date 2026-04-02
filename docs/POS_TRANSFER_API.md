# POS Transfer API
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What it is and why it exists

`POST /admin/pos-transfer` is a single-endpoint API that **forcefully transfers an Order or Draft Order to a new customer**. 

It exists because Medusa's native order transfer flow requires a token-based acceptance handshake (the customer must click an email link to accept the transfer). This flow is unsuitable for POS operations where staff need to reassign an order to a different customer immediately in the UI.

---

## How it Works

The endpoint bypasses Medusa's REST restrictions by calling `orderModule.updateOrders()` directly via the IoC container — this is the same underlying operation but without the email flow.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Order or Draft Order ID |
| `customer_id` | string | Yes | New customer ID to transfer to |
| `email` | string | No | Optional: update email on the order to match new customer |

**Response (success):**
```json
{
  "success": true,
  "message": "Successfully transferred ownership to customer cus_xxx",
  "order": { ...updatedOrder }
}
```

---

## POS Use Case

In the POS estimates/orders UI, a staff member can change the customer on an existing document. When they select a different customer:
1. POS calls `POST /admin/pos-transfer` with the order ID and new customer ID
2. The order is immediately reassigned in the database
3. The POS reflects the change without navigation

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| Route | `backend/src/api/admin/pos-transfer/route.ts` | POST handler |

---

## Rules

- Both `id` and `customer_id` are required — the endpoint returns 400 if either is missing
- This bypasses Medusa's transfer email flow intentionally — it should only be used from the POS admin interface (not exposed to customer-facing APIs)
- The `email` field is optional and only needed if the order email should also change (e.g., updating to the new customer's email)
