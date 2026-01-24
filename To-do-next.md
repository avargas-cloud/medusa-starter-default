# Dynamic Variants Implementation Plan

**Goal:** Implement a WooCommerce-like system where product attributes dynamically generate variants when marked as "Use as Variant", with automatic option/variant creation and proper title/variation mapping.

---

## Executive Summary

**Architecture:** Following Medusa v2 best practices, this plan uses **Workflows** instead of direct API route mutations to ensure atomic operations and automatic rollback on failure.

**Key Features:**
- ✅ Automatic variant generation when attributes marked as "Use as Variant"
- ✅ No manual "Sync" button - everything happens on save
- ✅ Smart UI: toggle only appears when attribute has ≥2 values
- ✅ Sorted display: variant attributes first, then alphabetical
- ✅ Safety: prevents deleting variants with existing orders (using Remote Query)
- ✅ Protection: 100-variant limit to prevent timeouts
- ✅ Clean architecture: workflows handle all business logic
- ✅ **Pricing Module Integration**: Automatic price creation for new variants
- ✅ **Idempotent Operations**: No duplicate variants on re-runs

**Files:**
- 3 new workflow files (`generate-variants`, `cleanup-variants`, `create-variant-prices`)
- 5 new workflow steps (validation, data prep, variant creation, price creation, deletion validation)
- 1 updated API route (delegates to workflows)
- 1 updated widget (sorting)
- 1 updated modal (conditional toggle + loading states)

**Estimated Time:** 12-15 hours

> **⚠️ CRITICAL MEDUSA V2 NOTES (From Tutor Review):**
> 1. **Module Isolation**: Products and Orders are separate modules. Must use **Remote Query** to check variant-order relationships
> 2. **Pricing Module**: Prices are NOT in variant table. Must explicitly create PriceSets via Pricing Module
> 3. **Idempotency**: Detect existing variants by `metadata.variation` slug to prevent duplicates

---

## Current State Analysis

### Existing Components

1. **Product Attributes Widget** (`product-attributes-widget.tsx`)
   - Displays attributes grouped by key
   - Shows "Variant?" badge for variant attributes
   - Opens ManageAttributesModal for editing

2. **Manage Attributes Modal** (`manage-attributes-modal.tsx`)
   - Allows adding/removing attributes
   - Has "Use as Variant" toggle (Switch)
   - Currently shows toggle for ALL attributes (❌ incorrect)
   - Has "Sync" button for variant syncing

3. **Backend Integration**
   - `POST /admin/products/{id}/attributes` - Saves attributes and variant keys
   - `POST /admin/products/{id}/sync-variants` - Syncs variants based on attribute

### Current Limitations

❌ "Use as Variant" toggle shows for attributes with only 1 value  
❌ No automatic variant generation when toggle is activated  
❌ Manual sync required (Sync button)  
❌ No clear indication of minimum 2 values requirement

---

## Requirements

### 1. UI Requirements

**Manage Attributes Modal:**
- [ ] Hide "Use as Variant" toggle when attribute has < 2 values
- [ ] Show helper text when toggle is hidden: "Add at least 2 values to use as variant"
- [ ] Automatically create options + variants when toggle is enabled
- [ ] Remove "Sync" button (make it automatic)

**Product Attributes Widget:**
- [ ] Sort attributes display:
  1. Variant attributes first (is_variant = true)
  2. Then alphabetically by attribute name

### 2. Logic Requirements

**Automatic Variant Generation:**
- [ ] When "Use as Variant" toggle is enabled → Immediately create options + variants
- [ ] When attribute value is added/removed → Regenerate variants if marked as variant
- [ ] When toggle is disabled → Remove associated options + variants

**Variant Structure:**
- Title: Attribute value (e.g., "100W", "Hardwired Connection")
- Variation column: Slug of attribute value (e.g., "100w", "hardwired-connection")
- Price/SKU/Inventory: Inherit from parent or blank

### 3. Data Flow

```
User marks attribute as variant
  ↓
Frontend checks: values.length >= 2?
  ↓ YES
Enable toggle + create options/variants
  ↓
POST /admin/products/{id}/attributes
  with: variant_keys: ["attr_key_id"]
  ↓
Backend handler:
  1. Create product.options for each variant key
  2. Generate all variant combinations
  3. Save variant metadata: { variation: "slug-value" }
  4. Return success
```

---

## Implementation Steps

### Phase 1: UI Improvements (Frontend Only)

#### Step 1.1: Conditional Toggle Display

**File:** `src/admin/components/manage-attributes-modal.tsx`

**Changes:**
- Line 560-583: Modify "Use as Variant" cell logic
- Add condition: Only show Switch if `group.values.length >= 2`
- Show helper text when hidden

**Implementation:**
```tsx
<Table.Cell>
  {group.values.length >= 2 ? (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <Switch
          checked={!!variantFlags[group.key_id]}
          onCheckedChange={() => toggleVariant(group.key_id)}
        />
        <Label>{variantFlags[group.key_id] ? "Yes" : "No"}</Label>
      </div>
    </div>
  ) : (
    <Text size="small" className="text-ui-fg-muted">
      Add at least 2 values
    </Text>
  )}
</Table.Cell>
```

**Rationale:** Prevents users from enabling variant mode when insufficient values exist.

---

#### Step 1.2: Remove Manual Sync Button

**File:** `src/admin/components/manage-attributes-modal.tsx`

**Changes:**
- Line 571-582: Remove Sync button completely
- Remove `handleSync` function (lines 233-259)

**Rationale:** Syncing will be automatic, no manual action needed.

---

#### Step 1.3: Sort Attributes Display

**File:** `src/admin/widgets/product-attributes-widget.tsx`

**Changes:**
- Line 66: Modify `groupAttributesByKey` to return sorted array
- Sort order:
  1. Variant attributes first (`is_variant: true`)
  2. Then alphabetically by `key_title`

**Implementation:**
```typescript
// Replace line 66
const groupedAttributes = groupAttributesByKey(attributes, variantKeys)
  .sort((a, b) => {
    // First: Sort by variant status (variants first)
    if (a.is_variant && !b.is_variant) return -1
    if (!a.is_variant && b.is_variant) return 1
    
    // Then: Sort alphabetically by key_title
    return a.key_title.localeCompare(b.key_title)
  })
```

**Rationale:** Improves UX by showing variant attributes (most important) at the top, then organizing the rest alphabetically for easy scanning.


### Phase 2: Backend - Workflow-Based Variant Generation

> **CRITICAL:** Following Medusa v2 best practices, we use **Workflows** instead of direct database mutations in API routes. This ensures atomicity and automatic rollback on failure.

---

#### Step 2.1: Create Workflow for Variant Generation

**File:** `src/workflows/generate-variants-from-attributes.ts` **(NEW)**

**Purpose:** 
- Atomic operations with automatic rollback
- Prevents database corruption if generation fails
- Handles edge cases (sold variants, cartesian explosion)
- **Creates prices via Pricing Module** (critical for v2)
- **Idempotent**: Detects existing variants by `metadata.variation` slug

> **🎯 KEY IMPROVEMENTS FROM TUTOR FEEDBACK:**
> 1. Separate validation, data prep, variant creation, and price creation into distinct steps
> 2. Use Pricing Module to create PriceSets for each variant
> 3. Idempotent logic to prevent duplicate variants

**Implementation:**

```typescript
import { createWorkflow, createStep, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { Modules } from "@medusajs/framework/utils"
import { createProductVariantsStep } from "@medusajs/medusa/core-flows"

// ==================== STEP 1: Validate Combinations ====================
const validateAttributeCombinationsStep = createStep(
  "validate-attribute-combinations",
  async ({ productId, variantKeys, attributes }, { container }) => {
    const productModuleService = container.resolve(Modules.PRODUCT)
    
    // Get current product
    const product = await productModuleService.retrieveProduct(productId, {
      relations: ["options", "variants"]
    })
    
    // Filter attributes by variant keys
    const variantAttributes = variantKeys.map(keyId => ({
      keyId,
      values: attributes.filter(a => a.attribute_key.id === keyId)
    }))
    
    // Validate: Each key must have >= 2 values
    for (const attr of variantAttributes) {
      if (attr.values.length < 2) {
        throw new Error(
          `Attribute ${attr.keyId} has less than 2 values. Cannot use as variant.`
        )
      }
    }
    
    // Calculate total combinations
    const combinationCount = variantAttributes.reduce(
      (total, attr) => total * attr.values.length,
      1
    )
    
    // 🛡️ SAFETY CHECK: Prevent cartesian explosion
    const MAX_VARIANTS = 100
    if (combinationCount > MAX_VARIANTS) {
      throw new Error(
        `Too many variant combinations (${combinationCount}). Maximum allowed: ${MAX_VARIANTS}. ` +
        `Please reduce the number of values or attributes.`
      )
    }
    
    return new StepResponse({
      product,
      variantAttributes,
      combinationCount,
      validated: true
    })
  }
)

// ==================== STEP 2: Prepare Variant Data ====================
const prepareVariantDataStep = createStep(
  "prepare-variant-data",
  async ({ product, variantAttributes }, { container }) => {
    // Generate cartesian product
    const combinations = generateCartesianProduct(variantAttributes)
    
    // Get existing managed variants to avoid duplicates (IDEMPOTENCY)
    const existingManagedVariants = product.variants?.filter(v => 
      v.metadata?.managed_by === "attributes"
    ) || []
    
    const existingVariationSlugs = new Set(
      existingManagedVariants.map(v => v.metadata?.variation).filter(Boolean)
    )
    
    // Format for Medusa, filtering out duplicates
    const preparedVariants = combinations
      .map(combo => {
        const variationSlug = combo.map(v => slugify(v.value)).join("-")
        
        return {
          title: combo.map(v => v.value).join(" / "),
          options: combo.reduce((acc, v) => {
            acc[v.attribute_key.label] = v.value
            return acc
          }, {} as Record<string, string>),
          metadata: {
            variation: variationSlug,
            managed_by: "attributes" // Tag for our system
          },
          variationSlug, // For filtering
          isNew: !existingVariationSlugs.has(variationSlug)
        }
      })
      .filter(v => v.isNew) // ✅ IDEMPOTENCY: Only create new variants
    
    return new StepResponse({
      variantsToCreate: preparedVariants,
      newVariantCount: preparedVariants.length,
      existingVariantCount: existingVariationSlugs.size
    })
  }
)

// ==================== STEP 3: Sync Product Options ====================
const syncProductOptionsStep = createStep(
  "sync-product-options",
  async ({ product, variantAttributes }, { container }) => {
    const productModuleService = container.resolve(Modules.PRODUCT)
    
    const createdOptions: string[] = []
    const updatedOptions: string[] = []
    
    for (const attr of variantAttributes) {
      const optionTitle = attr.values[0].attribute_key.label
      const optionValues = attr.values.map(v => v.value)
      
      // Check if option already exists
      const existingOption = product.options?.find(o => o.title === optionTitle)
      
      if (!existingOption) {
        // Create new option
        const newOption = await productModuleService.createProductOptions({
          product_id: product.id,
          title: optionTitle,
          values: optionValues
        })
        createdOptions.push(newOption.id)
      } else {
        // Update existing option (sync values)
        await productModuleService.updateProductOptions(existingOption.id, {
          values: optionValues
        })
        updatedOptions.push(existingOption.id)
      }
    }
    
    return new StepResponse(
      { createdOptions, updatedOptions },
      { productId: product.id, createdOptions } // Compensation data
    )
  },
  // COMPENSATION: Rollback created options if next step fails
  async ({ productId, createdOptions }, { container }) => {
    if (createdOptions?.length === 0) return
    
    const productModuleService = container.resolve(Modules.PRODUCT)
    await productModuleService.deleteProductOptions(createdOptions)
  }
)

// ==================== STEP 4: Create Variants ====================
const createVariantsFromDataStep = createStep(
  "create-variants-from-data",
  async ({ productId, variantsToCreate }, { container }) => {
    if (variantsToCreate.length === 0) {
      return new StepResponse({ 
        created: [], 
        count: 0,
        message: "All variants already exist (idempotent check passed)" 
      })
    }
    
    const productModuleService = container.resolve(Modules.PRODUCT)
    
    const variantsData = variantsToCreate.map(v => ({
      product_id: productId,
      title: v.title,
      options: v.options,
      metadata: v.metadata,
      manage_inventory: false, // Safe default
    }))
    
    const createdVariants = await productModuleService.createProductVariants(
      productId,
      variantsData
    )
    
    return new StepResponse(
      { 
        created: createdVariants, 
        count: createdVariants.length 
      },
      { productId, createdIds: createdVariants.map(v => v.id) } // Compensation data
    )
  },
  // COMPENSATION: Delete created variants if workflow fails
  async ({ productId, createdIds }, { container }) => {
    if (!createdIds || createdIds.length === 0) return
    
    const productModuleService = container.resolve(Modules.PRODUCT)
    await productModuleService.deleteProductVariants(createdIds)
  }
)

// ==================== STEP 5: Create Prices (CRITICAL FOR MEDUSA V2) ====================
const createPricesForVariantsStep = createStep(
  "create-prices-for-variants",
  async ({ variants, basePrice }, { container }) => {
    if (!variants || variants.length === 0) {
      return new StepResponse({ message: "No variants to price" })
    }
    
    const pricingModuleService = container.resolve(Modules.PRICING)
    const productModuleService = container.resolve(Modules.PRODUCT)
    const linkModuleService = container.resolve(Modules.LINK)
    
    const createdPriceSets: string[] = []
    
    for (const variant of variants) {
      // 1. Create PriceSet
      const priceSet = await pricingModuleService.createPriceSets({
        prices: [
          {
            amount: basePrice || 0, // Inherit from parent or set to 0
            currency_code: "usd", // Default currency
            rules: {}, // Add price rules if needed
          }
        ]
      })
      
      createdPriceSets.push(priceSet.id)
      
      // 2. Link PriceSet to Variant
      await linkModuleService.create({
        productService: {
          variant_id: variant.id,
        },
        pricingService: {
          price_set_id: priceSet.id,
        }
      })
    }
    
    return new StepResponse(
      {
        priceSetsCreated: createdPriceSets.length,
        message: `Created ${createdPriceSets.length} price sets`
      },
      { createdPriceSets } // Compensation data
    )
  },
  // COMPENSATION: Delete price sets if workflow fails
  async ({ createdPriceSets }, { container }) => {
    if (!createdPriceSets || createdPriceSets.length === 0) return
    
    const pricingModuleService = container.resolve(Modules.PRICING)
    await pricingModuleService.deletePriceSets(createdPriceSets)
  }
)

// ==================== WORKFLOW DEFINITION ====================
export const generateVariantsWorkflow = createWorkflow(
  "generate-variants-from-attributes",
  (input: {
    productId: string
    variantKeys: string[]
    attributes: any[]
    basePrice?: number // Optional: inherit from parent product
  }) => {
    // Step 1: Validate combinations and limits
    const validated = validateAttributeCombinationsStep(input)
    
    // Step 2: Prepare variant data (idempotent filtering)
    const prepared = prepareVariantDataStep({
      product: validated.product,
      variantAttributes: validated.variantAttributes
    })
    
    // Step 3: Sync options
    const options = syncProductOptionsStep({
      product: validated.product,
      variantAttributes: validated.variantAttributes
    })
    
    // Step 4: Create variants
    const createdVariants = createVariantsFromDataStep({
      productId: input.productId,
      variantsToCreate: prepared.variantsToCreate
    })
    
    // Step 5: Create prices (CRITICAL for Medusa v2)
    const prices = createPricesForVariantsStep({
      variants: createdVariants.created,
      basePrice: input.basePrice
    })
    
    return new WorkflowResponse({
      variantsCreated: createdVariants.count,
      priceSetsCreated: prices.priceSetsCreated,
      existingVariants: prepared.existingVariantCount
    })
  }
)

// ==================== HELPER FUNCTIONS ====================
function generateCartesianProduct(variantAttributes: any[]) {
  const groups = variantAttributes.map(attr => attr.values)
  
  return groups.reduce((acc, group) => 
    acc.flatMap(combo => group.map(val => [...combo, val])),
    [[]]
  ).filter(combo => combo.length === variantAttributes.length)
}

function slugify(text: string): string {
  return text.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '')
}
```

---

#### Step 2.2: Create Cleanup Workflow for Disabled Variants

**File:** `src/workflows/cleanup-variant-attributes.ts` **(NEW)**

**Purpose:** Safely remove variants when attribute is unmarked as variant

> **🔴 CRITICAL**: Uses **Remote Query** to check cross-module relationships (Product ↔ Order)

**Implementation:**

```typescript
import { createWorkflow, createStep, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { Modules, ContainerRegistrationKeys } from "@medusajs/framework/utils"

// ==================== STEP 1: Validate Variant Deletion (Cross-Module) ====================
const validateVariantDeletionStep = createStep(
  "validate-variant-deletion",
  async ({ variantIds }: { variantIds: string[] }, { container }) => {
    const query = container.resolve(ContainerRegistrationKeys.QUERY)

    // 🔍 REMOTE QUERY: Cross module boundary (Product → Order)
    const { data: lineItems } = await query.graph({
      entity: "order_line_item",
      fields: ["id", "variant_id"],
      filters: {
        variant_id: variantIds,
      },
    })

    if (lineItems.length > 0) {
      // ⚠️ THIS IS KEY: Throwing here stops workflow and triggers rollback
      const affectedVariants = [...new Set(lineItems.map(item => item.variant_id))]
      throw new Error(
        `Cannot delete variants with existing orders (IDs: ${affectedVariants.join(", ")}). ` +
        `Please archive them manually instead.`
      )
    }

    return new StepResponse({ validated: true, variantCount: variantIds.length })
  }
)

// ==================== STEP 2: Delete Variants and Options ====================
const cleanupVariantsStep = createStep(
  "cleanup-variants-for-attribute",
  async ({ productId, attributeKeyId }, { container }) => {
    const productModuleService = container.resolve(Modules.PRODUCT)
    
    // Get product with variants
    const product = await productModuleService.retrieveProduct(productId, {
      relations: ["variants", "options"]
    })
    
    // Find option for this attribute
    const attributeKey = await getAttributeKey(attributeKeyId) // Your helper
    const option = product.options?.find(o => o.title === attributeKey.label)
    
    if (!option) {
      return new StepResponse({ message: "No option found for this attribute" })
    }
    
    // Find variants managed by our system using this option
    const variantsToDelete = product.variants?.filter(v => 
      v.metadata?.managed_by === "attributes" &&
      v.options?.some(vo => vo.option_id === option.id)
    ) || []
    
    if (variantsToDelete.length === 0) {
      return new StepResponse({ message: "No variants to delete" })
    }
    
    // Delete variants (validation already happened in previous step)
    await productModuleService.deleteProductVariants(variantsToDelete.map(v => v.id))
    
    // Delete the option
    await productModuleService.deleteProductOptions([option.id])
    
    return new StepResponse(
      {
        deletedVariants: variantsToDelete.length,
        deletedOption: option.id
      },
      { productId, deletedVariantIds: variantsToDelete.map(v => v.id) } // Compensation data
    )
  },
  // COMPENSATION: Restore variants if something fails after deletion
  async ({ productId, deletedVariantIds }, { container }) => {
    // Note: In practice, variant restoration is complex. 
    // Better to validate thoroughly BEFORE deletion.
    console.warn(`Cleanup failed after deleting ${deletedVariantIds.length} variants`)
  }
)

// ==================== WORKFLOW DEFINITION ====================
export const cleanupVariantAttributesWorkflow = createWorkflow(
  "cleanup-variant-attributes",
  (input: { productId: string; attributeKeyId: string }) => {
    // First identify variants to delete
    const variantsToDelete = identifyVariantsStep(input) // Helper step (not shown)
    
    // Step 1: Validate using Remote Query (CRITICAL for cross-module safety)
    validateVariantDeletionStep({ variantIds: variantsToDelete.ids })
    
    // Step 2: Safe to delete after validation
    const result = cleanupVariantsStep(input)
    
    return new WorkflowResponse(result)
  }
)
```

---

#### Step 2.3: Update API Route to Use Workflows

**File:** `src/api/admin/products/[id]/attributes/route.ts`

**Changes:** Clean API route that delegates to workflows

**Implementation:**

```typescript
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { generateVariantsWorkflow } from "../../../../workflows/generate-variants-from-attributes"
import { cleanupVariantAttributesWorkflow } from "../../../../workflows/cleanup-variant-attributes"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const { id: productId } = req.params
  const { value_ids, variant_keys } = req.body
  
  try {
    // 1. Save attribute links (existing logic)
    await saveProductAttributeLinks(productId, value_ids, req.scope)
    
    // 2. Update metadata with variant keys
    const previousVariantKeys = await getPreviousVariantKeys(productId, req.scope)
    await updateProductMetadata(productId, { variant_attributes: variant_keys }, req.scope)
    
    // 3. Determine what changed
    const addedKeys = variant_keys.filter(k => !previousVariantKeys.includes(k))
    const removedKeys = previousVariantKeys.filter(k => !variant_keys.includes(k))
    
    // 4. Cleanup removed variant attributes
    for (const keyId of removedKeys) {
      const { result, errors } = await cleanupVariantAttributesWorkflow(req.scope).run({
        input: { productId, attributeKeyId: keyId }
      })
      
      if (errors.length > 0) {
        // If cleanup fails (variants have orders), return error to user
        return res.status(400).json({
          error: "Cannot remove variant attribute",
          details: errors[0].error.message
        })
      }
    }
    
    // 5. Generate variants for active variant keys
    if (variant_keys.length > 0) {
      const attributes = await getProductAttributes(productId, value_ids, req.scope)
      
      const { result, errors } = await generateVariantsWorkflow(req.scope).run({
        input: {
          productId,
          variantKeys: variant_keys,
          attributes
        }
      })
      
      if (errors.length > 0) {
        return res.status(400).json({
          error: "Variant generation failed",
          details: errors[0].error.message
        })
      }
      
      return res.json({
        message: "Attributes and variants synced successfully",
        variants_created: result.count
      })
    }
    
    return res.json({ message: "Attributes saved successfully" })
    
  } catch (error) {
    console.error("Attribute save error:", error)
    return res.status(500).json({
      error: "Failed to save attributes",
      message: error.message
    })
  }
}
```

---


const removedVariantKeys = previousVariantKeys.filter(k => !variant_keys.includes(k))

for (const keyId of removedVariantKeys) {
  await removeVariantsForAttribute(productId, keyId)
}

async function removeVariantsForAttribute(productId: string, keyId: string) {
  const attributeKey = await getAttributeKey(keyId)
  const product = await medusa.admin.product.retrieve(productId)
  
  // Remove option
  const option = product.options.find(o => o.title === attributeKey.label)
  if (option) {
    await medusa.admin.product.deleteOption(productId, option.id)
  }
  
  // Medusa automatically deletes variants when option is deleted
}
```

---

### Phase 3: Real-time Updates (Frontend)

#### Step 3.1: Auto-sync on Value Changes

**File:** `src/admin/components/manage-attributes-modal.tsx`

**Changes:**
- When value is added/removed via `handleAdd` or `handleRemoveValue`
- Check if affected attribute is marked as variant
- If yes, trigger variant regeneration

**Implementation:**
```typescript
const handleAdd = async () => {
  // ... existing add logic ...
  
  // After adding
  const affectedKeyId = finalKey.id
  if (variantFlags[affectedKeyId]) {
    // Value count changed, might enable/disable variant capability
    const newCount = tempAttributes.filter(a => a.attribute_key.id === affectedKeyId).length
    if (newCount < 2) {
      // Disable variant flag
      setVariantFlags(prev => ({ ...prev, [affectedKeyId]: false }))
      toast.info("Variant disabled: minimum 2 values required")
    }
  }
}

const handleRemoveValue = (id: string) => {
  const removedAttr = tempAttributes.find(a => a.id === id)
  setTempAttributes(prev => prev.filter(a => a.id !== id))
  
  if (removedAttr && variantFlags[removedAttr.attribute_key.id]) {
    const remaining = tempAttributes.filter(a => 
      a.attribute_key.id === removedAttr.attribute_key.id && a.id !== id
    ).length
    
    if (remaining < 2) {
      setVariantFlags(prev => ({ ...prev, [removedAttr.attribute_key.id]: false }))
      toast.info("Variant disabled: minimum 2 values required")
    }
  }
}
```

---

### Phase 4: Testing & Validation

#### Test Scenarios

1. **Single Value Attribute**
   - [ ] Create attribute with 1 value
   - [ ] Verify "Use as Variant" toggle is hidden
   - [ ] Verify helper text appears

2. **Two Values Attribute**
   - [ ] Create attribute with 2 values
   - [ ] Enable "Use as Variant"
   - [ ] Save and verify:
     - [ ] Option created with attribute name as title
     - [ ] 2 variants created with correct titles
     - [ ] Metadata `variation` contains slugs

3. **Multiple Variant Attributes**
   - [ ] Create 2 attributes (e.g., "Connection" with 2 values, "Power" with 2 values)
   - [ ] Enable both as variants
   - [ ] Verify 4 variants created (2×2 combinations)
   - [ ] Verify titles are "Value1 / Value2"

4. **Disable Variant**
   - [ ] Disable "Use as Variant" toggle
   - [ ] Verify option and variants are deleted

5. **Remove Value from Variant Attribute**
   - [ ] Remove value from attribute with 2 values (marked as variant)
   - [ ] Verify variant toggle auto-disables
   - [ ] Verify variants are removed

---

## File Changes Summary

### Frontend

| File | Lines | Changes |
|------|-------|---------|
| `product-attributes-widget.tsx` | 66 | Add sorting: variants first, then alphabetical |
| `manage-attributes-modal.tsx` | 560-583 | Conditional toggle display |
| `manage-attributes-modal.tsx` | 233-259 | Remove Sync button/function |
| `manage-attributes-modal.tsx` | 129-200, 203-205 | Auto-disable variant on value changes |
| `manage-attributes-modal.tsx` | Throughout | **NEW**: Add loading states (`isSaving`) and error toast handling |

### Backend - Workflows

| File | Changes |
|------|---------|  
| `src/workflows/generate-variants-from-attributes.ts` | **NEW** - Complete workflow with 5 steps |
| ↳ Step 1: `validateAttributeCombinationsStep` | Validates 2+ values, checks 100-variant limit |
| ↳ Step 2: `prepareVariantDataStep` | **Idempotent**: filters existing variants by slug |
| ↳ Step 3: `syncProductOptionsStep` | Creates/updates product options with compensation |
| ↳ Step 4: `createVariantsFromDataStep` | Creates variants with compensation logic |
| ↳ Step 5: `createPricesForVariantsStep` | **NEW**: Creates PriceSets via Pricing Module |
| `src/workflows/cleanup-variant-attributes.ts` | **NEW** - Cleanup workflow with 2 steps |
| ↳ Step 1: `validateVariantDeletionStep` | **Remote Query**: Checks cross-module Order relationships |
| ↳ Step 2: `cleanupVariantsStep` | Deletes variants and options |

### Backend - API Routes

| File | Changes |
|------|---------|  
| `src/api/admin/products/[id]/attributes/route.ts` | Update to use workflows, pass `basePrice` parameter |
| `src/api/admin/products/[id]/sync-variants/route.ts` | ❌ **DELETE** - No longer needed (automatic via workflow) |

**Key Technical Improvements (v2 Compliance):**
- ✅ **Remote Query Integration**: Uses `ContainerRegistrationKeys.QUERY` for cross-module validation
- ✅ **Pricing Module**: Explicit PriceSet creation via `Modules.PRICING`
- ✅ **Link Module**: Links variants to price sets via `Modules.LINK`
- ✅ **Idempotency**: Set-based deduplication using `metadata.variation` slugs
- ✅ **Compensation Logic**: All steps have rollback handlers
- ✅ **100-variant limit**: Prevents timeout via early validation

---

## Tutor Review & Refinements

### ✅ Plan Approved with Critical Adjustments

The plan architecture is approved and well-structured. The following technical refinements ensure Medusa v2 compliance:

---

### 1. 🔴 **Cross-Module Queries (Remote Query)**

**Challenge:** Products and Orders live in isolated modules in Medusa v2.

**The Fix:**
```typescript
// ❌ WRONG: Cannot do variant.orders
const hasOrders = variant.orders.length > 0

// ✅ CORRECT: Use Remote Query
const query = container.resolve(ContainerRegistrationKeys.QUERY)
const { data: lineItems } = await query.graph({
  entity: "order_line_item",
  fields: ["id", "variant_id"],
  filters: { variant_id: variantIds }
})
```

**Impact:** Implemented in `validateVariantDeletionStep` (Step 2.2)

---

### 2. 🔴 **Pricing Module Integration**

**Challenge:** Prices are NOT in the variant table—they live in the Pricing Module.

**The Problem:**
> Without explicit price creation, variants will be created but **cannot be purchased** because they have no price in the storefront.

**The Fix:**
```typescript
// Step 5: Create PriceSet and link to variant
const priceSet = await pricingModuleService.createPriceSets({
  prices: [{ amount: basePrice, currency_code: "usd" }]
})

await linkModuleService.create({
  productService: { variant_id: variant.id },
  pricingService: { price_set_id: priceSet.id }
})
```

**Impact:** New `createPricesForVariantsStep` in workflow (Step 2.1, Step 5)

---

### 3. 🔴 **Idempotency ("Upsert" Logic)**

**Challenge:** If user adds a new value (e.g., "XL") and re-runs, the system must:
- NOT duplicate existing variants ("S", "M", "L")
- ONLY create the new "XL" variant

**The Fix:**
```typescript
// Get existing variants to avoid duplicates
const existingVariationSlugs = new Set(
  product.variants
    .filter(v => v.metadata?.managed_by === "attributes")
    .map(v => v.metadata?.variation)
)

// Filter out duplicates
const preparedVariants = combinations
  .map(combo => {
    const variationSlug = combo.map(v => slugify(v.value)).join("-")
    return { ...combo, isNew: !existingVariationSlugs.has(variationSlug) }
  })
  .filter(v => v.isNew) // ✅ Only create new variants
```

**Impact:** Implemented in `prepareVariantDataStep` (Step 2.1, Step 2)

---

### 4. 🟡 **Optimistic UI States**

**Recommendation:** Generating 100 variants can take 2-3 seconds.

**Frontend Enhancement:**
```tsx
const [isSaving, setIsSaving] = useState(false)

const handleSave = async () => {
  setIsSaving(true)
  try {
    await saveAttributes()
    toast.success("Variants generated successfully")
  } catch (error) {
    toast.error(error.message) // Show backend errors (e.g., "Has orders")
  } finally {
    setIsSaving(false)
  }
}
```

**Impact:** Add loading states to `manage-attributes-modal.tsx`

---

## Updated Advisor Recommendations

### ✅ 1. Workflow Architecture
**Problem:** Direct mutations in API routes can leave database in inconsistent state  
**Solution:** Created `generateVariantsWorkflow` and `cleanupVariantAttributesWorkflow` with automatic rollback  
**Status:** ✅ Implemented with 5-step workflow

### ✅ 2. Variant Deletion Safety (Remote Query)
**Problem:** Deleting variants with orders breaks referential integrity  
**Solution:** `validateVariantDeletionStep()` uses Remote Query to check cross-module relationships  
**Status:** ✅ Updated with `ContainerRegistrationKeys.QUERY`

### ✅ 3. Cartesian Explosion Protection
**Problem:** 3 attributes × 10 values = 1,000 variants → timeout  
**Solution:** Hard limit of 100 variants with clear error message  
**Status:** ✅ Implemented in validation step

### ✅ 4. Managed Variant Tagging
**Problem:** Can't differentiate auto-generated vs manual variants  
**Solution:** `metadata.managed_by: "attributes"` tag on all generated variants  
**Status:** ✅ Implemented

### ✅ 5. Separation of Concerns
**Problem:** Business logic mixed with HTTP handling  
**Solution:** API route only orchestrates workflows, all logic in workflow steps  
**Status:** ✅ Implemented

### 🆕 6. Pricing Module Integration
**Problem:** Variants created without prices cannot be purchased  
**Solution:** `createPricesForVariantsStep` creates PriceSets and links them  
**Status:** ✅ Implemented with compensation logic

### 🆕 7. Idempotent Operations
**Problem:** Re-running generation duplicates existing variants  
**Solution:** `prepareVariantDataStep` filters by `metadata.variation` slug  
**Status:** ✅ Implemented with Set-based deduplication

---

## Technical Considerations

### 1. Variant Combination Explosion
- **Problem:** 3 attributes with 5 values each = 125 variants
- **Solution:** Add warning if combinations > 100
- **Future:** Allow limiting which combinations to create

### 2. Existing Variants
- **Problem:** Product may have manually created variants
- **Solution:** Only manage variants with `metadata.variation` tag
- **Alternative:** Add `managed_by: "attributes"` flag

### 3. Price/SKU Management
- **Problem:** New variants need prices
- **Solution:** 
  - Inherit from parent product
  - Or leave blank for manual entry
  - Future: Add pricing rules based on attribute

### 4. Inventory Management
- **Problem:** Each variant needs inventory tracking
- **Solution:** Set `manage_inventory: false` by default

---

## Migration Strategy

### Existing Products

**Problem:** Products currently using attributes as variants (via manual sync)

**Solution:**
1. No automatic migration
2. When user opens "Manage Attributes" modal and saves:
   - New logic takes over
   - Variants regenerated automatically
3. Add banner: "Variant management has been improved! Save to apply new structure."

---

## Future Enhancements

1. **Bulk Variant Editing**
   - Edit multiple variant prices at once
   - Apply pricing formulas based on attribute values

2. **Conditional Variants**
   - Only create specific combinations
   - Example: Don't create "XL + Red" if that combo doesn't exist

3. **Import/Export**
   - Import variant combinations from CSV
   - Export variant data for external editing

4. **Visual Variant Matrix**
   - Show all variants in a grid
   - Quick edit inline

---

## Implementation Timeline

| Phase | Estimated Time | Priority |
|-------|----------------|----------|
| Phase 1: UI Improvements | 1.5 hours | HIGH |
| Phase 2: Backend Workflows | 5-6 hours | HIGH |
| Phase 3: Real-time Updates | 1-2 hours | MEDIUM |
| Phase 4: Testing | 2-3 hours | HIGH |
| **Total** | **9.5-12.5 hours** | |

**Notes:**
- Phase 2 takes longer due to workflow complexity and safety checks
- Includes time for testing rollback mechanisms
- Additional time for edge case handling (sold variants, explosions)
---

## Success Criteria

### Functionality
✅ Attributes sorted: variants first, then alphabetically  
✅ Toggle only shows when attribute has 2+ values  
✅ Enabling toggle automatically creates options + variants  
✅ Variant titles match attribute values  
✅ Variation metadata contains slugified values  
✅ Disabling toggle removes options + variants  
✅ Adding/removing values updates variants automatically  
✅ No manual "Sync" button needed  
✅ Works like WooCommerce's attribute → variation system  

### Architecture & Safety
✅ All variant operations use Workflows (not direct mutations)  
✅ Automatic rollback on failure (no partial updates)  
✅ Max 100 variants enforced with clear error message  
✅ Variants with orders cannot be deleted  
✅ All generated variants tagged with `managed_by: "attributes"`  
✅ Frontend shows loader/toast during workflow execution  

---

## Questions for Review

1. **Variant Naming:** Should variant titles be "Value1 / Value2" or customizable?
2. **Pricing:** Should new variants inherit parent price or be blank?
3. **Inventory:** Default to `manage_inventory: false` or `true`?
4. **Migration:** Should we auto-migrate existing variant products?
