# Attribute Management - Modular Structure

This directory contains the modularized attribute management feature.

## Structure

```
attribute-management/
├── hooks/
│   ├── useConfirmation.ts          # 67 lines - Confirmation logic
│   └── useAttributeActions.ts      # 61 lines - Add/remove/toggle actions
├── utils/
│   ├── validateVariants.ts         # 43 lines - Variant validation (min 2 values)
│   └── groupAttributes.ts          # 52 lines - Grouping & availability
└── components/                     # (Future expansion)
    └── AttributeRow.tsx            # Individual row component (if needed)
```

## Main Component

`manage-attributes-modal.tsx` - 232 lines (down from 633 lines)
- Only UI structure and coordination
- Imports all logic from modules
- Easy to maintain and test

## Key Features

### 1. Variant Validation (`utils/validateVariants.ts`)
- **Rule**: Minimum 2 values required for variant
- Toggle only shows when rule is met
- Returns validation details with reason

### 2. Confirmation Handling (`hooks/useConfirmation.ts`)
- Warns when disabling variants (destructive)
- Confirms when enabling variants (informative)
- Uses native window.confirm (always works)

### 3. Attribute Actions (`hooks/useAttributeActions.ts`)
- Add: Append new attribute value
- Remove: Delete value, auto-disable variant if last value
- Toggle: Enable/disable variant flag

### 4. Grouping Utils (`utils/groupAttributes.ts`)
- Groups flat attributes by key
- Checks availability of more values

## Benefits

✅ Each file < 100 lines
✅ Single responsibility per file
✅ Easy to test in isolation
✅ Safe to restore individual files
✅ Clear imports show dependencies
✅ TypeScript validates module boundaries

## Usage Example

```typescript
// Main modal imports specific utilities
import { shouldShowVariantToggle } from "./attribute-management/utils/validateVariants"
import { useConfirmation } from "./attribute-management/hooks/useConfirmation"

// Use in component
const { handleSaveWithConfirmation } = useConfirmation(initialVariantKeys, allKeys)
const showToggle = shouldShowVariantToggle(keyId, tempAttributes)
```

## Future Expansion

If needed, can add:
- `components/AttributeRow.tsx` - Individual row component
- `components/AddAttributeForm.tsx` - Separate add form
- `hooks/useAttributeData.ts` - Separate data fetching
- `utils/formatting.ts` - Display formatters

---

**Created**: 2026-01-24
**Lines Reduced**: 633 → 232 (63% reduction in main file)
**Total Module Lines**: ~220 lines across 4 files
