# Product Attributes Widget (PDP)

> [!NOTE]
> This document details the **Details Widget** injected into the Product Detail Page (PDP), allowing merchants to view and manage attributes for a specific product.

---


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Document the custom Medusa widget injected into the Product Detail Page (PDP) at `product.details.after`, allowing merchants to view and manage the custom Many-to-Many relationship between a product and its attribute values. |
| **Problemas que resuelve** | The need to manage product attributes (e.g., "Color: Red, Blue", "Wattage: 12W") without navigating away from the product page. Also documents the dual-fetch strategy and the `groupAttributesByKey` helper pattern. |
| **Resultado esperado** | Developers understand how to build and extend PDP widgets in Medusa v2, manage Many-to-Many attribute links, and display grouped attribute data in the admin UI. |
| **Scripts Creados** | `inspect/inspect-attribute-sets.ts`, `show/show-product-attrs.ts`, `verify/verify-product-attrs.ts`, `verify/verify-links.ts`, `verify/verify-links-correctly.ts` |

## 1. Overview
The **Product Attributes Widget** (`src/admin/widgets/product-attributes-widget.tsx`) injects a dedicated section into the generic Product Details page (`product.details.after`). It fetches, displays, and manages the custom many-to-many relationships between the current Product and its Attributes.

## 2. Key Features

### A. Context-Aware Injection
- **Zone**: `product.details.after`
- **Behavior**: Automatically appears on every Product page without requiring core view modifications.

### B. "Grouped" Visualization
- **Raw Data**: The backend Link entity returns a flat list of connections (e.g., `Product -> [Value1, Value2, Value3]`).
- **Processing**: The widget uses a local helper `groupAttributesByKey` to pivot this flat data into a user-friendly hierarchy:
  ```
  Material (Key)
  ├── Wood (Value)
  └── Metal (Value)
  ```
- **Display**: Renders a clean Table with columns for "Attribute", "Values" (as Badges), and "Variant Status".

### C. Variant Context
- **Metadata Sync**: Checks `product.metadata.variant_attributes` to see if a specific Attribute Key is flagged as defining variants (e.g., "Size" might be a Variant attribute, while "Material" is just informational).
- **Visual Indicator**: Shows a purple "Variant" badge for keys that drive SKU differentiation.

### D. Atomic Management
- **Edit Modal**: Launches `ManageAttributesModal` (the complex modal detailed in [ADMIN_PANEL_PRODUCT_ATTRIBUTES_MODAL_UX_AND_SAVE_LOGIC.md](./ADMIN_PANEL_PRODUCT_ATTRIBUTES_MODAL_UX_AND_SAVE_LOGIC.md)).
- **Atomic Saving**: The widget handles the final persistence via `handleSave`.
  - It constructs a `POST` payload with `value_ids` (all linked values) and `variant_keys` (metadata flags).
  - It sends this to the custom endpoint `/admin/products/:id/attributes` which executes the workflow `updateProductAttributesWorkflow`.

---

## 3. Technical Implementation

### Data Fetching strategy
The widget uses a dual-fetch strategy to ensure it has the absolute latest data, independent of the main page's cache:
1.  **Attributes**: `GET /admin/products/:id/attributes` (Custom Endpoint) - Fetches the pivot table links.
2.  **Metadata**: `sdk.admin.product.retrieve` - Fetches the product's metadata to ensure `variant_attributes` flags are up to date.

### Helper Function
`groupAttributesByKey(flatAttributes, variantKeys)`:
- Iterates over flat links.
- Aggregates values sharing the same `attribute_key.id`.
- Flags the group as `is_variant` if the key ID exists in the `variantKeys` array.

---

> [!TIP]
> **Architecture Note**: This widget is "dumb" regarding *what* attributes exist; it only knows what is linked. All creation/definition logic is delegated to the Modal, separating concerns effectively.
