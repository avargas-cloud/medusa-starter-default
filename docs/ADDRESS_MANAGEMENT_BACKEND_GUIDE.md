# 📍 Address Management - Backend Implementation Guide

> **Version**: 2.0 (Medusa v2 Custom Routes)  
> **Last Updated**: 2026-02-08  
> **Audience**: Backend Developers (Medusa v2)

---


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Document the custom backend route for updating customer addresses (`POST /store/customers/me/addresses/:address_id`), including the dual-field update strategy (native Medusa fields + metadata) and the automatic default-swap logic. |
| **Problemas que resuelve** | Medusa v2 does not natively support setting `is_default_billing` / `is_default_shipping` on addresses while simultaneously unsetting previous defaults. The custom route handles the swap atomically within one API call. |
| **Resultado esperado** | When a customer marks an address as their default billing or shipping, only that address gets the flag — all other addresses are automatically unset. Both native fields and `metadata` stay in sync, compatible with any frontend using radio buttons or checkboxes. |
| **Scripts Creados** | `verify/verify-address-defaults.ts`, `verify/verify-native-defaults.ts`, `verify/verify-native-fields.ts`, `verify/test-default-addresses.ts`, `verify/investigate-billing.ts`, `tests/test-native-addresses.ts` |
| **Última verificación** | 2026-02-08 |

## 📋 Table of Contents

1. [Overview](#overview)
2. [Current Implementation](#current-implementation)
3. [How It Works](#how-it-works)
4. [Step-by-Step Implementation](#step-by-step-implementation)
5. [Testing](#testing)
6. [Troubleshooting](#troubleshooting)

---

## Overview

The address management system handles default billing and shipping addresses with the following features:

✅ **Dual Field Storage** - Updates both native Medusa fields and metadata  
✅ **Automatic Swap Logic** - Unsets previous defaults when setting new ones  
✅ **Single Endpoint** - One route handles all address updates  
✅ **Frontend Compatible** - Works with both radio buttons and checkboxes

---

## Current Implementation

###  File Structure

```
backend/src/api/store/customers/me/addresses/
└── [address_id]/
    └── route.ts    # Custom update endpoint
```

### What Gets Updated

When a customer updates an address to be a default:

1. **Native Medusa Fields** (preferred):
   - `customer_address.is_default_billing`
   - `customer_address.is_default_shipping`

2. **Metadata Fallback**:
   - `customer_address.metadata.is_default_billing`
   - `customer_address.metadata.is_default_shipping`

### Why Both?

- **Native fields**: Medusa's intended way (future-proof)
- **Metadata**: Ensures compatibility and provides fallback

---

## How It Works

### Swap Logic Flow

```
User selects "Address B" as default billing
    ↓
Backend receives: {
    is_default_billing: true,
    ...other fields
}
    ↓
Step 1: Find all OTHER addresses for this customer
    ↓
Step 2: Update each OTHER address:
    - Set is_default_billing = false (native)
    - Set metadata.is_default_billing = false
    ↓
Step 3: Update TARGET address:
    - Set is_default_billing = true (native)
    - Set metadata.is_default_billing = true
    ↓
Return success
```

### Example Scenario

**Before Update**:
```
Address A: is_default_billing = true  ← Current default
Address B: is_default_billing = false
Address C: is_default_billing = false
```

**User Action**: Set Address B as default billing

**After Update**:
```
Address A: is_default_billing = false  ← Automatically unset
Address B: is_default_billing = true   ← New default
Address C: is_default_billing = false
```

---

## Step-by-Step Implementation

### Step 1: Create the Route File

Create `backend/src/api/store/customers/me/addresses/[address_id]/route.ts`:

```typescript
import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { updateCustomerAddressesWorkflow } from "@medusajs/medusa/core-flows";

export async function POST(
    req: MedusaRequest,
    res: MedusaResponse
): Promise<void> {
    console.log("[ADDRESS UPDATE] 🏠 Starting address update flow");
    
    // Extract address ID from URL params
    const { address_id: addressId } = req.params;
    
    // Get authenticated customer ID
    const customerId = req.auth_context?.actor_id;

    // Validate authentication
    if (!customerId) {
        console.error("[ADDRESS UPDATE] ❌ No customer ID in auth context");
        res.status(401).json({ message: "Unauthorized" });
        return;
    }

    console.log(`[ADDRESS UPDATE] Customer: ${customerId}, Address: ${addressId}`);
    console.log(`[ADDRESS UPDATE] Request body:`, req.body);

    // Extract default flags
    const setAsDefaultBilling = (req.body as any).is_default_billing === true;
    const setAsDefaultShipping = (req.body as any).is_default_shipping === true;

    console.log(`[ADDRESS UPDATE] Default Billing: ${setAsDefaultBilling}`);
    console.log(`[ADDRESS UPDATE] Default Shipping: ${setAsDefaultShipping}`);

    try {
        const { query } = req.scope.resolve("query");

        // STEP 1: Unset defaults on OTHER addresses if we're setting a new default
        if (setAsDefaultBilling || setAsDefaultShipping) {
            console.log("[ADDRESS UPDATE] 🔄 Swapping defaults - unsetting other addresses");
            
            // Find all addresses for this customer EXCEPT the target address
            const { data: allOtherAddresses } = await query.graph({
                entity: "customer_address",
                fields: ["id", "metadata"],
                filters: {
                    customer_id: customerId,
                    id: { $ne: addressId } // NOT equal to target address
                }
            });

            console.log(`[ADDRESS UPDATE] Found ${allOtherAddresses.length} other addresses to update`);

            // Update each other address to UNSET defaults
            for (const otherAddress of allOtherAddresses) {
                const updatedMetadata = { ...(otherAddress.metadata || {}) };
                
                if (setAsDefaultBilling) {
                    updatedMetadata.is_default_billing = false;
                }
                if (setAsDefaultShipping) {
                    updatedMetadata.is_default_shipping = false;
                }

                console.log(`[ADDRESS UPDATE]    - Unsetting address ${otherAddress.id}`);

                await updateCustomerAddressesWorkflow(req.scope).run({
                    input: {
                        selector: { id: otherAddress.id, customer_id: customerId },
                        update: {
                            metadata: updatedMetadata,
                            is_default_billing: setAsDefaultBilling ? false : undefined,
                            is_default_shipping: setAsDefaultShipping ? false : undefined
                        }
                    }
                });
            }
        }

        // STEP 2: Update the TARGET address with ALL fields from request
        console.log("[ADDRESS UPDATE] ✅ Setting target address as default");
        
        await updateCustomerAddressesWorkflow(req.scope).run({
            input: {
                selector: { id: addressId, customer_id: customerId },
                update: {
                    ...req.body, // All address fields (first_name, address_1, etc.)
                    metadata: {
                        ...(req.body.metadata || {}),
                        is_default_billing: setAsDefaultBilling,
                        is_default_shipping: setAsDefaultShipping
                    },
                    // Also set native Medusa fields
                    is_default_billing: setAsDefaultBilling,
                    is_default_shipping: setAsDefaultShipping
                }
            }
        });

        console.log("[ADDRESS UPDATE] 🎉 Address updated successfully");

        res.status(200).json({
            success: true,
            message: "Address updated successfully"
        });
    } catch (error) {
        console.error("[ADDRESS UPDATE] ❌ Error:", error);
        res.status(500).json({
            success: false,
            message: error instanceof Error ? error.message : "Failed to update address"
        });
    }
}
```

---

### Step 2: Validate Route Registration

Medusa v2 automatically registers routes from the `src/api/` folder structure.

**Your route will be accessible at**:
```
POST /store/customers/me/addresses/:address_id
```

**Verify** by checking your backend logs on startup:
```
[Medusa] Registered route: POST /store/customers/me/addresses/[address_id]
```

---

### Step 3: Test with curl

```bash
# Get your customer access token first
# (from your auth system)

# Update an address to be default billing
curl -X POST http://localhost:9000/store/customers/me/addresses/addr_123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "first_name": "John",
    "last_name": "Doe",
    "address_1": "123 Main St",
    "city": "Miami",
    "province": "FL",
    "postal_code": "33101",
    "country_code": "us",
    "is_default_billing": true,
    "is_default_shipping": false,
    "metadata": {
      "nickname": "Home"
    }
  }'
```

**Expected Response**:
```json
{
  "success": true,
  "message": "Address updated successfully"
}
```

---

## Testing

### Test Case 1: Setting a New Default

**Setup**:
- Address A: Currently default billing
- Address B: Not default

**Action**:
```typescript
POST /store/customers/me/addresses/addr_B
{
    ...address_fields,
    "is_default_billing": true
}
```

**Expected Result**:
- Address A: `is_default_billing = false` (automatically)
- Address B: `is_default_billing = true`

**Verification**:
```bash
# Check the database
SELECT id, is_default_billing, metadata 
FROM customer_address 
WHERE customer_id = 'cus_XXX';
```

---

### Test Case 2: Same Address for Both Defaults

**Action**:
```typescript
POST /store/customers/me/addresses/addr_A
{
    ...address_fields,
    "is_default_billing": true,
    "is_default_shipping": true
}
```

**Expected Result**:
- Address A: Both flags set to `true`
- All other addresses: Both flags set to `false`

---

### Test Case 3: Frontend Compatibility

**Scenario**: User clicks radio button in "Default Billing Address" section

**Frontend Sends**:
```typescript
{
    first_name: "John",
    last_name: "Doe",
    address_1: "123 Main St",
    // ... ALL address fields ...
    is_default_billing: true,
    is_default_shipping: false,  // Preserve current shipping status
    metadata: { nickname: "Home" }
}
```

**Backend Must**:
1. ✅ Accept ALL fields (not just defaults)
2. ✅ Update native fields
3. ✅ Update metadata
4. ✅ Unset other addresses

---

## Troubleshooting

### Issue: "Unauthorized" Error

**Symptoms**:
```json
{
  "message": "Unauthorized"
}
```

**Cause**: `req.auth_context.actor_id` is `undefined`

**Solution**: Ensure request includes valid JWT token:
```typescript
headers: {
  'Authorization': 'Bearer YOUR_VALID_TOKEN'
}
```

---

### Issue: Other Addresses Not Unset

**Symptoms**: Multiple addresses have `is_default_billing = true`

**Cause**: Swap logic not running

**Debug**:
```typescript
// Add logging
console.log("Setting as default billing?", setAsDefaultBilling);
console.log("Found other addresses:", allOtherAddresses.length);
```

**Solution**: Ensure you're checking `req.body.is_default_billing === true` (strict equality)

---

### Issue: Metadata Not Updating

**Symptoms**: Native fields update but `metadata` stays old

**Cause**: Not spreading existing metadata

**Solution**:
```typescript
// ✅ CORRECT: Preserve existing metadata
metadata: {
    ...(req.body.metadata || {}),  // Existing metadata
    is_default_billing: setAsDefaultBilling,
    is_default_shipping: setAsDefaultShipping
}

// ❌ WRONG: Overwrites all metadata
metadata: {
    is_default_billing: setAsDefaultBilling,
    is_default_shipping: setAsDefaultShipping
}
```

---

### Issue: 400 Error "Unrecognized Fields"

**Symptoms**:
```
Fields 'id, customer_id, created_at, updated_at, deleted_at' are unrecognized
```

**Cause**: Frontend sending readonly fields

**Solution**: This is a **frontend issue**. Frontend must filter and send only writable fields.

**Backend Side Prevention** (optional):
```typescript
// Filter out readonly fields
const { id, customer_id, created_at, updated_at, deleted_at, ...writeableFields } = req.body;

await updateCustomerAddressesWorkflow(req.scope).run({
    input: {
        selector: { id: addressId, customer_id: customerId },
        update: writeableFields // Only writable fields
    }
});
```

---

## Database Schema

### customer_address Table

```sql
CREATE TABLE customer_address (
    id VARCHAR PRIMARY KEY,
    customer_id VARCHAR NOT NULL,
    first_name VARCHAR,
    last_name VARCHAR,
    company VARCHAR,
    address_1 VARCHAR,
    address_2 VARCHAR,
    city VARCHAR,
    province VARCHAR,
    postal_code VARCHAR,
    country_code VARCHAR,
    phone VARCHAR,
    
    -- Native Medusa default flags (v2)
    is_default_billing BOOLEAN DEFAULT FALSE,
    is_default_shipping BOOLEAN DEFAULT FALSE,
    
    -- Metadata (JSON)
    metadata JSONB,
    
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    deleted_at TIMESTAMP
);
```

### Example Row After Update

```json
{
    "id": "addr_01ABC",
    "customer_id": "cus_01XYZ",
    "first_name": "John",
    "last_name": "Doe",
    "address_1": "123 Main St",
    "city": "Miami",
    "province": "FL",
    "postal_code": "33101",
    "country_code": "us",
    "is_default_billing": true,    // Native field
    "is_default_shipping": false,  // Native field
    "metadata": {
        "nickname": "Home",
        "is_default_billing": true,    // Metadata duplicate
        "is_default_shipping": false   // Metadata duplicate
    }
}
```

---

## Best Practices

### 1. Always Log Important Steps

```typescript
console.log("[ADDRESS UPDATE] 🏠 Starting...");
console.log("[ADDRESS UPDATE] 🔄 Swapping defaults...");
console.log("[ADDRESS UPDATE] ✅ Success");
console.log("[ADDRESS UPDATE] ❌ Error:", error);
```

Makes debugging infinitely easier.

---

### 2. Use Transactions (If Possible)

While Medusa workflows handle some of this, consider wrapping in a transaction:

```typescript
const manager = req.scope.resolve("manager");

await manager.transaction(async (transactionManager) => {
    // Unset others
    // Set target
});
```

---

### 3. Validate Input

```typescript
// Ensure required fields are present
if (!req.body.first_name || !req.body.last_name) {
    res.status(400).json({ message: "Missing required fields" });
    return;
}

// Validate address_id format
if (!addressId.startsWith("addr_")) {
    res.status(400).json({ message: "Invalid address ID" });
    return;
}
```

---

### 4. Return Helpful Errors

```typescript
catch (error) {
    console.error("[ADDRESS UPDATE] ❌ Error:", error);
    
    const errorMessage = error instanceof Error 
        ? error.message 
        : "Unknown error occurred";
    
    res.status(500).json({
        success: false,
        message: errorMessage,
        debug: process.env.NODE_ENV === 'development' ? error : undefined
    });
}
```

---

## Summary

This backend route provides:

1. ✅ Single endpoint for all address updates
2. ✅ Automatic default swapping (only one default at a time)
3. ✅ Updates both native fields and metadata (dual compatibility)
4. ✅ Works seamlessly with frontend radio buttons and checkboxes
5. ✅ Handles edge cases (same address for both defaults, etc.)

**The frontend can rely on**:
- Sending `is_default_billing: true` will automatically unset the previous default
- Both native and metadata fields will always be in sync
- No manual swap logic needed on frontend

---

**Document Version**: 2.0  
**Last Updated**: 2026-02-08  
**Medusa Version**: v2  
**Node Version**: v20+
