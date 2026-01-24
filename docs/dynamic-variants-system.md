# Dynamic Variants System - Complete Technical Documentation

> **Purpose**: This document provides a complete technical reference for the Dynamic Product Variants system. Use this to recreate the entire system from scratch if needed.

## Table of Contents
1. [System Overview](#system-overview)
2. [Architecture](#architecture)
3. [Data Flow](#data-flow)
4. [Backend Components](#backend-components)
5. [Frontend Components](#frontend-components)
6. [Workflows](#workflows)
7. [API Routes](#api-routes)
8. [Step-by-Step Recreation Guide](#step-by-step-recreation-guide)
9. [Troubleshooting](#troubleshooting)

---

## System Overview

### What This System Does

The Dynamic Variants system allows users to:
1. Assign product attributes (e.g., "Color Options", "Size") as variant-generating properties
2. Automatically generate all variant combinations when 2+ values exist
3. Safely disable variant attributes with order protection
4. See real-time updates in the admin UI without page refreshes

### Key Features

- ✅ **Automatic Variant Generation**: Creates all combinations (e.g., Red-Small, Red-Large, Blue-Small, Blue-Large)
- ✅ **Safety Protection**: Prevents deletion of variants with existing orders
- ✅ **Real-time UI Updates**: All widgets refresh automatically after changes
- ✅ **Modular Architecture**: Small, single-responsibility files following modularization policy

---

## Architecture

### High-Level Component Map

```
┌─────────────────────────────────────────────────────────────┐
│                         FRONTEND                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Product Attributes Widget (product-attributes-widget.tsx) │
│         │                                                   │
│         ├─► Manage Attributes Modal                        │
│         │   (manage-attributes-modal.tsx)                  │
│         │         │                                         │
│         │         ├─► useConfirmation Hook                 │
│         │         ├─► useAttributeActions Hook             │
│         │         ├─► ConfirmationDialog Component         │
│         │         └─► Validation Utils                     │
│         │                                                   │
│         └─► API Call: POST /attributes                     │
│                      │                                      │
└──────────────────────┼──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                         BACKEND                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  API Route: /admin/products/[id]/attributes/route.ts       │
│         │                                                   │
│         ├─► Update Product Attributes Workflow             │
│         │                                                   │
│         ├─► Safe Delete Option Workflow                    │
│         │         │                                         │
│         │         ├─► Find Variants by Option Step         │
│         │         ├─► Check Variant Sales Step             │
│         │         ├─► Delete Variants Step                 │
│         │         └─► Delete Option Step                   │
│         │                                                   │
│         └─► Variant Generation Logic                       │
│                                                             │
│  Subscriber: protect-managed-options.ts                    │
│         │                                                   │
│         └─► Logs post-delete events (audit trail)          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Complete Request Flow

#### 1. User Enables a Variant Attribute

```
USER ACTION: Toggle "Color Options" as variant
    │
    ├─► Frontend validates (needs 2+ values)
    │
    └─► POST /admin/products/{id}/attributes
        {
          value_ids: ["val1", "val2", ...],
          variant_keys: ["key1_id"]  // Color Options key ID
        }
            │
            ├─► Backend: updateProductAttributesWorkflow
            │   └─► Updates product.metadata.variant_attributes = ["key1_id"]
            │
            ├─► Backend: Variant Generation
            │   ├─► Fetches all attribute values
            │   ├─► Creates product option "Color Options"
            │   ├─► Generates cartesian product (all combinations)
            │   ├─► Creates N variants
            │   └─► Links price sets to each variant
            │
            └─► Frontend: Query Invalidation + Refetch
                ├─► Invalidates all product queries
                ├─► Refetches attributes
                ├─► Refetches product metadata
                └─► UI updates instantly (variants appear, badge shows)
```

#### 2. User Disables a Variant Attribute

```
USER ACTION: Untoggle "Color Options" as variant
    │
    └─► POST /admin/products/{id}/attributes
        {
          value_ids: ["val1", "val2", ...],
          variant_keys: []  // Removed Color Options
        }
            │
            ├─► Backend: updateProductAttributesWorkflow
            │   └─► Updates product.metadata.variant_attributes = []
            │
            ├─► Backend: Safe Delete Option Workflow
            │   │
            │   ├─► Step 1: findVariantsByOptionStep
            │   │   └─► Returns [variant1_id, variant2_id]
            │   │
            │   ├─► Step 2: checkVariantSalesStep
            │   │   ├─► Queries order_line_item via remoteQuery
            │   │   ├─► If orders found → BLOCKS deletion
            │   │   │   └─► Returns HTTP 400 error to frontend
            │   │   └─► If no orders → Proceeds to Step 3
            │   │
            │   ├─► Step 3: deleteVariantsStep
            │   │   └─► Deletes all safe variants
            │   │
            │   └─► Step 4: deleteOptionStep
            │       └─► Deletes the product option
            │
            ├─► Event: ProductEvents.PRODUCT_OPTION_DELETED
            │   └─► Subscriber logs the deletion (audit)
            │
            └─► Frontend: Query Invalidation + Refetch
                └─► UI updates (option removed, variants gone, badge removed)
```

---

## Backend Components

### 1. API Route: `/admin/products/[id]/attributes/route.ts`

**Location**: `src/api/admin/products/[id]/attributes/route.ts`

**Purpose**: Main orchestration endpoint for attribute management

#### GET Handler

```typescript
// Fetches all product attributes
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id } = req.params
    
    // 1. Get attribute links
    const { data: links } = await query.graph({
        entity: "product_attribute_value",
        fields: ["attribute_value_id"],
        filters: { product_id: id }
    })
    
    // 2. Get attribute details
    const { data: attributes } = await query.graph({
        entity: "attribute_value",
        fields: ["id", "value", "attribute_key.id", "attribute_key.label", "attribute_key.handle"],
        filters: { id: ids }
    })
    
    res.json({ attributes })
}
```

#### POST Handler - Key Sections

**Section 1: Update Attributes**
```typescript
await updateProductAttributesWorkflow(req.scope).run({
    input: {
        productId,
        valueIds: value_ids || [],
        variantKeys: variant_keys || [],
    }
})
```

**Section 2: Safe Deletion of Removed Variant Keys**
```typescript
const removedKeys = previousVariantKeys.filter(k => !newKeys.includes(k))

if (removedKeys.length > 0) {
    for (const keyId of removedKeys) {
        // Find option to delete
        const optionToDelete = productWithOptions.options?.find(o => o.title === keyLabel)
        
        if (optionToDelete) {
            // Call Safe Delete Workflow
            const workflowResult = await safeDeleteOptionWorkflow(req.scope).run({
                input: { optionId: optionToDelete.id }
            })
            
            const result = workflowResult.result
            
            // Check if blocked by existing orders
            if (result.protectedVariants.length > 0) {
                return res.status(400).json({
                    error: "Cannot disable variant attribute",
                    message: "Some variants have existing orders and cannot be deleted.",
                    protectedVariants: result.protectedVariants
                })
            }
        }
    }
}
```

**Section 3: Variant Generation for New Keys**
```typescript
if (newKeys.length > 0) {
    // 1. Fetch attributes and group by key
    const variantAttributes = newKeys.map(keyId => ({
        keyId,
        label: attributes.find(a => a.attribute_key.id === keyId)?.attribute_key?.label,
        values: attributes.filter(a => a.attribute_key.id === keyId)
    }))
    
    // 2. Validate: each must have 2+ values
    for (const attr of variantAttributes) {
        if (attr.values.length < 2) {
            return res.status(400).json({
                message: `Attribute "${attr.label}" needs at least 2 values`
            })
        }
    }
    
    // 3. Create product options
    for (const attr of variantAttributes) {
        const existingOption = productWithOptions.options?.find(o => o.title === attr.label)
        
        if (!existingOption) {
            await productService.createProductOptions([{
                product_id: productId,
                title: attr.label,
                values: attr.values.map(v => v.value)
            }])
        }
    }
    
    // 4. Generate all combinations (cartesian product)
    const combinations = generateCartesianProduct(variantAttributes.map(a => a.values))
    
    // 5. Create variants
    const variantsToCreate = combinations.map(combo => ({
        product_id: productId,
        title: combo.map(v => v.value).join(" / "),
        options: combo.reduce((acc, v) => {
            acc[v.attribute_key.label] = v.value
            return acc
        }, {}),
        metadata: {
            managed_by: "attributes",
            variation: combo.map(v => slugify(v.value)).join("-")
        },
        manage_inventory: false
    }))
    
    const newVariants = await productService.createProductVariants(variantsToCreate)
    
    // 6. Create price sets
    for (const variant of newVariants) {
        const priceSet = await pricingService.createPriceSets({
            prices: [{
                amount: 0,
                currency_code: "usd",
                rules: {}
            }]
        })
        
        await remoteLink.create({
            [Modules.PRODUCT]: { variant_id: variant.id },
            [Modules.PRICING]: { price_set_id: priceSet.id }
        })
    }
}
```

**Helper Function: Cartesian Product**
```typescript
function generateCartesianProduct(arrays: any[][]): any[][] {
    if (arrays.length === 0) return [[]]
    if (arrays.length === 1) return arrays[0].map(item => [item])
    
    const [first, ...rest] = arrays
    const restProduct = generateCartesianProduct(rest)
    
    return first.flatMap(item =>
        restProduct.map(restItems => [item, ...restItems])
    )
}
```

---

### 2. Safe Delete Option Workflow

**Location**: `src/workflows/variant-cleanup/safe-delete-option.ts`

**Purpose**: Orchestrates safe deletion with order protection

```typescript
import { createWorkflow, WorkflowResponse, transform } from "@medusajs/framework/workflows-sdk"
import { checkVariantSalesStep } from "./steps/check-variant-sales"
import { findVariantsByOptionStep } from "./steps/find-variants-by-option"
import { deleteVariantsStep } from "./steps/delete-variants"
import { deleteOptionStep } from "./steps/delete-option"

type SafeDeleteOptionInput = {
    optionId: string
}

export const safeDeleteOptionWorkflow = createWorkflow(
    "safe-delete-option-with-cleanup",
    (input: SafeDeleteOptionInput) => {
        // Step 1: Find all variants using this option
        const variantsResult = findVariantsByOptionStep({ optionId: input.optionId })
        
        // Step 2: Safety check - query for existing orders
        const safetyResult = checkVariantSalesStep(variantsResult)
        
        // Step 3: Delete variants (only safe ones)
        deleteVariantsStep(
            transform({ safetyResult }, (data) => ({
                variantIds: data.safetyResult.safeToDelete
            }))
        )
        
        // Step 4: Delete the option itself
        deleteOptionStep({ optionId: input.optionId })
        
        // Return workflow result
        return new WorkflowResponse(
            transform({ safetyResult }, (data) => ({
                optionId: input.optionId,
                variantsDeleted: data.safetyResult.safeToDelete.length,
                protectedVariants: data.safetyResult.protectedVariants,
                success: true
            }))
        )
    }
)
```

**CRITICAL NOTES**:
- Workflow composers MUST be pure functions
- NO `console.log()` or side-effects in the composer
- Use `transform()` to access properties from WorkflowData objects
- Console logging only allowed inside step functions

---

### 3. Workflow Steps

#### Step 1: Find Variants by Option

**Location**: `src/workflows/variant-cleanup/steps/find-variants-by-option.ts`

```typescript
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

export const findVariantsByOptionStep = createStep(
    "find-variants-by-option",
    async (input: { optionId: string }, { container }) => {
        const productService = container.resolve(Modules.PRODUCT)
        
        console.log(`🔍 Finding variants for option: ${input.optionId}`)
        
        const variants = await productService.listProductVariants({
            options: { id: [input.optionId] }
        })
        
        const variantIds = variants.map(v => v.id)
        console.log(`   Found ${variantIds.length} variants to check`)
        
        return new StepResponse({ variantIds })
    }
)
```

#### Step 2: Check Variant Sales

**Location**: `src/workflows/variant-cleanup/steps/check-variant-sales.ts`

```typescript
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

export const checkVariantSalesStep = createStep(
    "check-variant-sales",
    async (input: { variantIds: string[] }, { container }) => {
        if (input.variantIds.length === 0) {
            return new StepResponse({
                safeToDelete: [],
                protectedVariants: []
            })
        }
        
        const query = container.resolve("query")
        
        console.log(`🔍 Checking ${input.variantIds.length} variants for existing orders...`)
        
        // Query order line items
        const { data: orderLineItems } = await query.graph({
            entity: "order_line_item",
            fields: ["id", "variant_id"],
            filters: {
                variant_id: input.variantIds
            }
        })
        
        // Build sales map
        const salesByVariant: Record<string, number> = {}
        orderLineItems.forEach((item: any) => {
            salesByVariant[item.variant_id] = (salesByVariant[item.variant_id] || 0) + 1
        })
        
        // Separate safe vs protected
        const safeToDelete: string[] = []
        const protectedVariants: Array<{ variantId: string; orderCount: number }> = []
        
        for (const variantId of input.variantIds) {
            const orderCount = salesByVariant[variantId] || 0
            
            if (orderCount > 0) {
                console.log(`   ⚠️ Variant ${variantId}: PROTECTED (${orderCount} orders)`)
                protectedVariants.push({ variantId, orderCount })
            } else {
                console.log(`   ✅ Variant ${variantId}: Safe to delete`)
                safeToDelete.push(variantId)
            }
        }
        
        return new StepResponse({
            safeToDelete,
            protectedVariants
        })
    }
)
```

#### Step 3: Delete Variants

**Location**: `src/workflows/variant-cleanup/steps/delete-variants.ts`

```typescript
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

export const deleteVariantsStep = createStep(
    "delete-variants",
    async (input: { variantIds: string[] }, { container }) => {
        if (input.variantIds.length === 0) {
            console.log("   ℹ️ No variants to delete")
            return new StepResponse({ deleted: 0 }, [])
        }
        
        const productService = container.resolve(Modules.PRODUCT)
        
        console.log(`🗑️ Deleting ${input.variantIds.length} variants...`)
        
        await productService.deleteProductVariants(input.variantIds)
        
        console.log(`   ✅ Deleted ${input.variantIds.length} variants`)
        
        return new StepResponse({ 
            deleted: input.variantIds.length
        }, input.variantIds)
    },
    async (deletedIds: string[] | undefined, { container }) => {
        // Compensation: restore deleted variants if workflow fails
        console.log(`   ⏪ Compensation: Would restore ${deletedIds?.length || 0} variants`)
    }
)
```

#### Step 4: Delete Option

**Location**: `src/workflows/variant-cleanup/steps/delete-option.ts`

```typescript
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"

export const deleteOptionStep = createStep(
    "delete-option",
    async (input: { optionId: string }, { container }) => {
        const productService = container.resolve(Modules.PRODUCT)
        
        console.log(`🗑️ Deleting option: ${input.optionId}`)
        await productService.deleteProductOptions([input.optionId])
        console.log(`   ✅ Option deleted`)
        
        return new StepResponse({ optionId: input.optionId })
    }
)
```

---

### 4. Subscriber: Protection Monitor

**Location**: `src/subscribers/protect-managed-options.ts`

**Purpose**: Audit trail for option deletions (executes AFTER deletion)

```typescript
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"

export default async function protectManagedOptionsHandler({
    event: { data },
    container,
}: SubscriberArgs<{ id: string }>) {
    const query = container.resolve("query")
    const deletedOptionId = data.id

    console.log(`🛡️ [PROTECTION POST-DELETE] Option was deleted: ${deletedOptionId}`)
    console.log(`   Note: This fires AFTER deletion. Cannot block the operation.`)

    // Check if option still exists in any product
    const { data: products } = await query.graph({
        entity: "product",
        fields: ["id", "title", "options.id"],
        filters: {
            options: {
                id: [deletedOptionId]
            }
        }
    })

    if (products.length > 0) {
        console.warn(`   ⚠️ Option ${deletedOptionId} still found in ${products.length} product(s)`)
    } else {
        console.log(`   ✅ Option not found in any product (already deleted)`)
    }
}

export const config: SubscriberConfig = {
    event: "product.product_option.deleted",
}
```

---

## Frontend Components

### 1. Product Attributes Widget

**Location**: `src/admin/widgets/product-attributes-widget.tsx`

**Purpose**: Displays attributes table and manages modal

#### Key Features

1. **Dual Query System**
```typescript
// Query 1: Attributes data
const { data: customData, refetch } = useQuery({
    queryFn: async () => {
        return sdk.client.fetch(`/admin/products/${initialProduct.id}/attributes`)
    },
    queryKey: [["product", initialProduct.id, "custom-attributes"]]
})

// Query 2: Product metadata (for variant_keys)
const { data: productData, refetch: refetchProduct } = useQuery({
    queryFn: async () => {
        return sdk.admin.product.retrieve(initialProduct.id)
    },
    queryKey: [["product", initialProduct.id, "fresh-metadata"]]
})
```

2. **Attribute Grouping and Sorting**
```typescript
const groupedAttributes = groupAttributesByKey(attributes, variantKeys)
    .sort((a, b) => {
        // Variants first
        if (a.is_variant && !b.is_variant) return -1
        if (!a.is_variant && b.is_variant) return 1
        
        // Then alphabetically
        return a.key_title.localeCompare(b.key_title)
    })
```

3. **Comprehensive Query Invalidation**
```typescript
const handleSave = async (selectedAttributes, variantFlags) => {
    // 1. Make API call
    await sdk.client.fetch(`/admin/products/${initialProduct.id}/attributes`, {
        method: "POST",
        body: { value_ids: valueIds, variant_keys: activeVariantKeys }
    })
    
    // 2. Invalidate ALL related queries
    await queryClient.invalidateQueries({ queryKey: ['product', initialProduct.id] })
    await queryClient.invalidateQueries({ queryKey: ['products', initialProduct.id] })
    await queryClient.invalidateQueries({ queryKey: ['product_options'] })
    await queryClient.invalidateQueries({ queryKey: ['product_variants'] })
    await queryClient.invalidateQueries({
        predicate: (query) => {
            const key = query.queryKey
            return Array.isArray(key) && key.includes(initialProduct.id)
        }
    })
    
    // 3. Force refetch BOTH queries
    await Promise.all([
        refetch(),           // Refetch attributes
        refetchProduct()     // Refetch product metadata (for variant_keys)
    ])
    
    setIsManageModalOpen(false)
}
```

---

### 2. Manage Attributes Modal

**Location**: `src/admin/components/manage-attributes-modal.tsx`

**Modular Structure**: (Following Agent Policy: Modularization)

```
src/admin/components/
└── attribute-management/
    ├── README.md                         # Module documentation
    ├── utils/
    │   ├── validateVariants.ts          # Min 2 values validation
    │   └── groupAttributes.ts           # Grouping & availability logic
    ├── hooks/
    │   ├── useConfirmation.ts           # Confirmation dialog state
    │   └── useAttributeActions.ts       # Add/remove/toggle actions
    └── components/
        └── ConfirmationDialog.tsx       # Reusable Medusa UI dialog
```

#### Main Modal Component

```typescript
export const ManageAttributesModal = ({ product, open, onOpenChange }) => {
    // State management
    const [selectedAttributes, setSelectedAttributes] = useState([])
    const [variantFlags, setVariantFlags] = useState({})
    
    // Custom hooks
    const { add, remove, toggle } = useAttributeActions(
        selectedAttributes,
        setSelectedAttributes,
        variantFlags,
        setVariantFlags
    )
    
    const { 
        confirmationType, 
        pendingKey, 
        showConfirmation, 
        confirmAction, 
        cancelAction 
    } = useConfirmation(variantFlags, toggle)
    
    // Validation
    const validationErrors = validateVariantEligibility(selectedAttributes, variantFlags)
    
    return (
        <FocusModal open={open} onOpenChange={onOpenChange}>
            <FocusModal.Content className="w-2/3 mx-auto">
                {/* Header */}
                <FocusModal.Header />
                
                {/* Body with internal scroll */}
                <FocusModal.Body className="overflow-y-auto max-h-[calc(100vh-200px)]">
                    {/* Add new attribute section */}
                    {/* Attributes table with variant toggles */}
                    {/* Individual value delete buttons */}
                </FocusModal.Body>
                
                {/* Footer with Save/Cancel */}
                <FocusModal.Footer>
                    <Button onClick={handleSave}>Save</Button>
                </FocusModal.Footer>
            </FocusModal.Content>
            
            {/* Confirmation Dialog */}
            <ConfirmationDialog
                open={showConfirmation}
                type={confirmationType}
                onConfirm={confirmAction}
                onCancel={cancelAction}
            />
        </FocusModal>
    )
}
```

#### Validation Utility

**Location**: `src/admin/components/attribute-management/utils/validateVariants.ts`

```typescript
export const validateVariantEligibility = (
    selectedAttributes: any[],
    variantFlags: Record<string, boolean>
) => {
    const errors: Record<string, string> = {}
    
    Object.entries(variantFlags).forEach(([keyId, isEnabled]) => {
        if (isEnabled) {
            const values = selectedAttributes.filter(
                a => a.attribute_key.id === keyId
            )
            
            if (values.length < 2) {
                const keyLabel = values[0]?.attribute_key?.label || "Unknown"
                errors[keyId] = `"${keyLabel}" needs at least 2 values to generate variants`
            }
        }
    })
    
    return errors
}
```

---

## Step-by-Step Recreation Guide

### If System Breaks: Complete Rebuild Steps

#### Phase 1: Backend Workflows

1. **Create Workflow Steps Directory**
```bash
mkdir -p src/workflows/variant-cleanup/steps
```

2. **Create Each Step File** (see [Workflow Steps](#3-workflow-steps) section above)
   - `find-variants-by-option.ts`
   - `check-variant-sales.ts`
   - `delete-variants.ts`
   - `delete-option.ts`

3. **Create Main Workflow**
   - `safe-delete-option.ts` (see [Safe Delete Option Workflow](#2-safe-delete-option-workflow))

4. **Create Index Export**
```typescript
// src/workflows/variant-cleanup/index.ts
export { safeDeleteOptionWorkflow } from "./safe-delete-option"
export { checkVariantSalesStep } from "./steps/check-variant-sales"
export { findVariantsByOptionStep } from "./steps/find-variants-by-option"
export { deleteVariantsStep } from "./steps/delete-variants"
export { deleteOptionStep } from "./steps/delete-option"
```

#### Phase 2: API Route

1. **Create API Route Structure**
```bash
mkdir -p src/api/admin/products/[id]/attributes
```

2. **Implement route.ts** (see [API Route](#1-api-route-adminproductsidattributesroutets) section)
   - GET handler for fetching attributes
   - POST handler with three sections:
     - Update attributes workflow
     - Safe deletion for removed keys
     - Variant generation for new keys

3. **Add Helper Functions**
   - `generateCartesianProduct()`
   - `slugify()`

#### Phase 3: Subscriber

1. **Create Subscriber**
```bash
mkdir -p src/subscribers
```

2. **Implement protect-managed-options.ts** (see [Subscriber](#4-subscriber-protection-monitor))

#### Phase 4: Frontend Modularization

1. **Create Component Structure**
```bash
mkdir -p src/admin/components/attribute-management/{utils,hooks,components}
```

2. **Create Utilities**
   - `utils/validateVariants.ts`
   - `utils/groupAttributes.ts`

3. **Create Hooks**
   - `hooks/useConfirmation.ts`
   - `hooks/useAttributeActions.ts`

4. **Create Components**
   - `components/ConfirmationDialog.tsx`

5. **Refactor Main Modal**
   - Extract logic into hooks and utils
   - Keep main file under 300 lines

#### Phase 5: Widget Implementation

1. **Update Product Attributes Widget**
   - Add dual query system
   - Implement comprehensive invalidation
   - Add `refetchProduct()` call

2. **Test Query Invalidation**
   - Verify all widgets update on save
   - Confirm no F5 needed

---

## Troubleshooting

### Common Issues

#### 1. "object is not a function" Error

**Cause**: Console.log or side-effects in workflow composer

**Solution**: Remove ALL `console.log()` from workflow composer function. Only use console.log inside step functions.

```typescript
// ❌ Wrong
export const myWorkflow = createWorkflow("my-workflow", (input) => {
    console.log("Starting...") // BREAKS!
    return new WorkflowResponse(result)
})

// ✅ Correct
export const myWorkflow = createWorkflow("my-workflow", (input) => {
    const result = myStep(input) // Steps can have console.log
    return new WorkflowResponse(result)
})
```

#### 2. Widget Not Refreshing After Save

**Cause**: Not refetching product metadata query

**Solution**: Ensure both queries are refetched:
```typescript
await Promise.all([
    refetch(),           // Attributes
    refetchProduct()     // Metadata
])
```

#### 3. Cannot Access WorkflowData Properties

**Cause**: Attempting to access properties directly on WorkflowData

**Solution**: Use `transform()` utility
```typescript
// ❌ Wrong
const safetyResult = checkVariantSalesStep({ variantIds: variantsResult.variantIds })

// ✅ Correct
const safetyResult = checkVariantSalesStep(variantsResult)
deleteVariantsStep(
    transform({ safetyResult }, (data) => ({
        variantIds: data.safetyResult.safeToDelete
    }))
)
```

#### 4. Variants Not Deleted When Disabling Attribute

**Cause**: Workflow not being called or failing silently

**Debug Steps**:
1. Check logs for `🧹 Starting safe cleanup`
2. Verify workflow is imported in API route
3. Check for HTTP 400 errors (protected variants)
4. Verify workflow returns `.result` property

#### 5. "Option not found (already deleted)" Warning

**Cause**: Subscriber executing after workflow deletion

**Status**: **This is NORMAL behavior**. The subscriber is an audit log that runs after the option is deleted. Not an error.

---

## Performance Considerations

### Cartesian Product Limits

The system limits variant combinations to **100 maximum** to prevent database overload:

```typescript
if (combinations.length > 100) {
    return res.status(400).json({
        message: `Too many combinations: ${combinations.length}. Max 100.`
    })
}
```

**Example**: 
- 3 attributes with 5 values each = 5³ = 125 combinations (BLOCKED)
- 2 attributes with 10 values each = 10² = 100 combinations (ALLOWED)

### Query Optimization

All queries use specific field selection to minimize data transfer:
```typescript
fields: ["id", "value", "attribute_key.id", "attribute_key.label"]
```

---

## Security & Data Integrity

### Order Protection

Variants with existing orders **cannot** be deleted:
- Safety check queries `order_line_item` table
- Blocks deletion if any orders found
- Returns detailed error with order counts

### Atomic Operations

Workflows ensure all-or-nothing operations:
- If any step fails, entire workflow rolls back
- Compensation functions restore state
- No partial deletions

---

## Testing Guide

### Manual Test Cases

#### Test 1: Enable Variant Attribute
1. Create product with attribute "Color" having values: Red, Blue
2. Toggle "Color" as variant
3. Click Save
4. Verify:
   - ✅ Product Options widget shows "Color Options"
   - ✅ Variants widget shows 2 new variants
   - ✅ Product Attributes widget shows "Variant" badge
   - ✅ Attribute appears first in sorted list

#### Test 2: Disable Variant (No Orders)
1. From Test 1, untoggle "Color" as variant
2. Click Save
3. Verify:
   - ✅ Confirmation dialog appears
   - ✅ After confirm, variants are deleted
   - ✅ Option is removed
   - ✅ Badge disappears
   - ✅ No F5 required

#### Test 3: Protected Deletion (With Orders)
1. Create product with variant attribute
2. Create an order using one variant
3. Try to disable variant attribute
4. Verify:
   - ✅ API returns HTTP 400 error
   - ✅ Error message shows order count
   - ✅ No variants deleted
   - ✅ Option remains

#### Test 4: Multiple Variant Attributes
1. Create attributes: Color (Red, Blue) and Size (S, L)
2. Enable both as variants
3. Verify:
   - ✅ 4 variants created (Red-S, Red-L, Blue-S, Blue-L)
   - ✅ Both appear with "Variant" badges
   - ✅ Sorted to top of list

---

## Files Modified/Created

### Backend
- ✅ `src/workflows/variant-cleanup/safe-delete-option.ts`
- ✅ `src/workflows/variant-cleanup/steps/check-variant-sales.ts`
- ✅ `src/workflows/variant-cleanup/steps/find-variants-by-option.ts`
- ✅ `src/workflows/variant-cleanup/steps/delete-variants.ts`
- ✅ `src/workflows/variant-cleanup/steps/delete-option.ts`
- ✅ `src/workflows/variant-cleanup/index.ts`
- ✅ `src/api/admin/products/[id]/attributes/route.ts`
- ✅ `src/subscribers/protect-managed-options.ts`

### Frontend
- ✅ `src/admin/widgets/product-attributes-widget.tsx`
- ✅ `src/admin/components/manage-attributes-modal.tsx`
- ✅ `src/admin/components/attribute-management/utils/validateVariants.ts`
- ✅ `src/admin/components/attribute-management/utils/groupAttributes.ts`
- ✅ `src/admin/components/attribute-management/hooks/useConfirmation.ts`
- ✅ `src/admin/components/attribute-management/hooks/useAttributeActions.ts`
- ✅ `src/admin/components/attribute-management/components/ConfirmationDialog.tsx`
- ✅ `src/admin/components/attribute-management/README.md`

### Documentation
- ✅ `docs/AGENT_POLICY_MODULARIZATION.md`
- ✅ `docs/notebooklm-formatting-guide.md`
- ✅ `docs/dynamic-variants-system.md` (this document)

---

## Maintenance Notes

### Code Modularization Policy

All files must follow the modularization policy:
- **Maximum 300 lines per file**
- **Single responsibility principle**
- Break large files into utils, hooks, and sub-components

**Why**: Prevents loss of work when restoring files

### Workflow Best Practices

1. **Never use side-effects in composers**
   - No console.log
   - No direct DB access
   - Pure functions only

2. **Use `transform()` for data extraction**
   - WorkflowData objects cannot be accessed directly
   - Always use transform to extract properties

3. **Type safety**
   - Define clear input/output types for steps
   - Use TypeScript interfaces

4. **Compensation functions**
   - Always include compensation logic
   - Handle rollback scenarios

---

## Future Enhancements

### Potential Improvements

1. **Bulk Operations**
   - Enable/disable multiple variant attributes at once
   - Batch variant generation

2. **Advanced Safety Checks**
   - Check for variants in carts (not just orders)
   - Check for variants in draft orders

3. **Variant Templates**
   - Save variant configurations for reuse
   - Apply templates to multiple products

4. **Performance Optimization**
   - Cache cartesian product calculations
   - Lazy-load variant generation for large combinations

---

## Support & Contact

For questions or issues with this system:
1. Review this documentation first
2. Check the [Troubleshooting](#troubleshooting) section
3. Review implementation in [Knowledge Base](../knowledge/wsl_node_development_troubleshooting/)

---

**Last Updated**: 2026-01-24  
**Version**: 1.0  
**Status**: Production Ready ✅
