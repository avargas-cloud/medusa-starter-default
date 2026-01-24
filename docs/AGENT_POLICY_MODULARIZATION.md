# Agent Policy: Code Modularization

## Core Principle

**NEVER create monolithic files. ALWAYS fragment code into small, focused modules.**

## Why This Matters

When you restore a large file from git, you lose ALL changes:
- ❌ Lost validation logic
- ❌ Lost confirmation handlers
- ❌ Lost helper functions
- ❌ Everything in that file is gone

With modular code:
- ✅ Restore affects only one small file
- ✅ Other modules remain intact
- ✅ Easier to test and maintain
- ✅ Clearer responsibilities

## Mandatory Rules

### Rule 1: Maximum File Size

**Absolute Maximum**: 300 lines per file

If a file exceeds 200 lines, strongly consider refactoring.

### Rule 2: One Responsibility Per File

Each file should have ONE clear purpose:
- ✅ `useVariantValidation.ts` - Validation logic only
- ✅ `useConfirmation.ts` - Confirmation modal logic only
- ❌ `manage-attributes-modal.tsx` - Everything (BAD)

### Rule 3: Extract Functions to Separate Files

Instead of:
```typescript
// manage-attributes-modal.tsx (600 lines)
const ManageModal = () => {
    const validateVariant = () => { /* 50 lines */ }
    const handleConfirm = () => { /* 30 lines */ }
    const groupByKey = () => { /* 40 lines */ }
    // ... 400+ more lines
}
```

Do this:
```typescript
// hooks/useVariantValidation.ts (50 lines)
export const useVariantValidation = () => { /* logic */ }

// hooks/useConfirmation.ts (30 lines)
export const useConfirmation = () => { /* logic */ }

// utils/groupAttributes.ts (40 lines)
export const groupAttributesByKey = () => { /* logic */ }

// ManageAttributesModal.tsx (100 lines)
import { useVariantValidation } from './hooks/useVariantValidation'
import { useConfirmation } from './hooks/useConfirmation'
import { groupAttributesByKey } from './utils/groupAttributes'

const ManageModal = () => {
    const validate = useVariantValidation()
    const confirm = useConfirmation()
    // Just UI logic here
}
```

### Rule 4: Standard Folder Structure

For any complex component, use this structure:

```
src/admin/components/[feature]/
├── index.ts                    # Public exports
├── [Feature]Container.tsx      # Main container (UI only)
├── hooks/
│   ├── use[Feature]Data.ts     # Data fetching
│   ├── use[Feature]Actions.ts  # Actions/mutations
│   └── use[Feature]State.ts    # Local state management
├── components/
│   ├── [Feature]Form.tsx       # Sub-components
│   ├── [Feature]List.tsx
│   └── [Feature]Item.tsx
└── utils/
    ├── validation.ts           # Validation logic
    ├── formatting.ts           # Formatters
    └── constants.ts            # Constants
```

Example for attributes:
```
src/admin/components/attribute-management/
├── index.ts
├── ManageAttributesModal.tsx   # 100 lines - just UI structure
├── hooks/
│   ├── useAttributeData.ts     # Fetching attributes
│   ├── useVariantValidation.ts # Min 2 values check
│   ├── useConfirmation.ts      # Confirmation logic
│   └── useAttributeActions.ts  # Add/remove/toggle
├── components/
│   ├── AttributeRow.tsx        # Single attribute row
│   ├── AddAttributeForm.tsx    # Add new form
│   └── ConfirmationDialog.tsx  # Confirmation UI
└── utils/
    ├── groupAttributes.ts      # Group by key logic
    └── validateVariantFlags.ts # Validation helpers
```

### Rule 5: When Implementing New Features

**BEFORE writing code**, ask yourself:

1. Will this file exceed 200 lines?
   - If YES: Plan module structure first
   
2. Does this have multiple responsibilities?
   - If YES: Split into separate files
   
3. Could this logic be reused?
   - If YES: Extract to utils/ or hooks/

4. Will editing this file risk breaking other functionality?
   - If YES: It's too large, refactor first

### Rule 6: Refactoring Trigger Points

Refactor immediately when:
- File reaches 200 lines
- Adding new feature to existing large file
- Function is used in multiple places
- Logic is complex (>50 lines for one function)
- You need to restore file from git

### Rule 7: Git Restore Safety

When you need to restore a file:

**Before Restore**:
1. Extract all custom logic to separate files
2. Commit those files
3. NOW restore the main file
4. Re-import the extracted logic

**Example**:
```bash
# DON'T do this:
git checkout HEAD -- manage-attributes-modal.tsx  # Loses everything

# DO this:
# 1. Extract first
cp manage-attributes-modal.tsx manage-attributes-modal.backup.tsx
# Create useConfirmation.ts with confirmation logic
git add hooks/useConfirmation.ts
git commit -m "Extract confirmation logic"
# 2. Now safe to restore
git checkout HEAD -- manage-attributes-modal.tsx
# 3. Re-import
# Import useConfirmation in manage-attributes-modal.tsx
```

## Practical Examples

### Example 1: Attribute Management (Current Bad State)

**BEFORE** (Monolithic):
```
manage-attributes-modal.tsx - 610 lines
- UI structure
- Data fetching
- Validation logic
- Confirmation handling
- Add/remove logic
- Sync functionality
```

**AFTER** (Modular):
```
ManageAttributesModal.tsx - 100 lines (UI only)
hooks/useAttributeData.ts - 50 lines
hooks/useVariantValidation.ts - 40 lines
hooks/useConfirmation.ts - 30 lines
hooks/useAttributeActions.ts - 60 lines
components/AttributeRow.tsx - 50 lines
components/AddAttributeForm.tsx - 40 lines
utils/groupAttributes.ts - 30 lines
utils/validateVariants.ts - 20 lines
```

### Example 2: API Routes

**BEFORE** (Monolithic):
```
src/api/admin/products/[id]/attributes/route.ts - 234 lines
- GET handler
- POST handler
- Cleanup logic
- Variant generation
- Pricing integration
```

**AFTER** (Modular):
```
route.ts - 50 lines (route definitions only)
handlers/getAttribute.ts - 30 lines
handlers/syncAttributes.ts - 40 lines
services/variantCleanup.ts - 50 lines
services/variantGeneration.ts - 60 lines
utils/pricingIntegration.ts - 40 lines
```

## Migration Strategy

For existing large files:

### Phase 1: Identify Responsibilities
List all functions and group by purpose

### Phase 2: Create Module Files
One file per responsibility group

### Phase 3: Extract & Test
Move one group at a time, test after each

### Phase 4: Update Main File
Import and use extracted modules

### Phase 5: Document
Add comments explaining module structure

## Enforcement

This is a **MANDATORY** policy for:
- All new features
- Any file edits that bring size >200 lines
- Before major refactors
- When requested by user

## Benefits Checklist

When code is properly modularized:
- [ ] Each file <200 lines
- [ ] Clear file naming shows purpose
- [ ] Easy to find specific logic
- [ ] Can restore single file safely
- [ ] Tests are isolated and simple
- [ ] Reduces merge conflicts
- [ ] Easier code review
- [ ] Better TypeScript performance

## Anti-Patterns to Avoid

### ❌ DON'T: "Everything in one file for convenience"
### ❌ DON'T: "I'll refactor later" (you won't)
### ❌ DON'T: Copy-paste logic instead of extracting to shared file
### ❌ DON'T: Mix concerns (UI + business logic + data fetching in one file)

### ✅ DO: Extract early and often
### ✅ DO: Use TypeScript to enforce module boundaries
### ✅ DO: Create index.ts to expose public API
### ✅ DO: Keep related files close in folder structure

---

**Remember**: Time spent organizing code saves 10x time later debugging and maintaining.

**Last Updated**: 2026-01-24
