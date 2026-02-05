# Scripts Directory

## 📁 Structure

Scripts are organized into categorized subdirectories for better maintainability:

### Validation & Checking
- **`checks/`** (44 scripts) - Validation scripts that check state without modifying
- **`verify/`** (29 scripts) - Post-implementation verification scripts

### Testing & Debugging
- **`tests/`** (25 scripts) - Test scripts for various features
- **`debug/`** (19 scripts) - Debugging scripts for troubleshooting

### Data Operations
- **`migrations/`** (14 scripts) - Data migration scripts
- **`sync/`** (12 scripts) - Synchronization scripts (QB, Meili, categories)
- **`import/`** (3 scripts) - Data import scripts
- **`export/`** (1 script) - Data export scripts

### Resource Management
- **`create/`** (8 scripts) - Resource creation scripts
- **`delete/`** (12 scripts) - Resource deletion scripts
- **`cleanup/`** (10 scripts) - Data cleanup scripts

### Maintenance & Repair
- **`fix/`** (12 scripts) - Repair/healing scripts
- **`force/`** (6 scripts) - Force operations
- **`nuclear/`** (3 scripts) - Nuclear/destructive operations
- **`reset/`** (3 scripts) - Reset scripts

### Discovery & Analysis
- **`find/`** (8 scripts) - Resource search scripts
- **`list/`** (8 scripts) - List/enumerate resources
- **`show/`** (4 scripts) - Display information
- **`inspect/`** (8 scripts) - Inspection scripts
- **`investigate/`** (4 scripts) - Investigation scripts
- **`diagnostics/`** (6 scripts) - Deep diagnostic scripts
- **`analyze/`** (2 scripts) - Analysis scripts
- **`compare/`** (3 scripts) - Data comparison scripts

### System Operations
- **`enable/`** (4 scripts) - Enable/activate features
- **`organize/`** (1 script) - Organization scripts
- **`setup/`** (1 script) - Setup scripts
- **`trigger/`** (1 script) - Trigger operations
- **`get/`** (2 scripts) - Getter scripts
- **`recover/`** (2 scripts) - Recovery scripts
- **`propagate/`** (1 script) - Propagation scripts
- **`rebuild/`** (1 script) - Rebuild operations

### Special Directories
- **`_archive/`** - Archived scripts (no longer in use)
- **`_deprecated/`** - Deprecated scripts (kept for reference)

## 📚 Documentation Files

- `README.md` - This file
- `AUTH_SCRIPTS_REFERENCE.md` - Authentication scripts reference
- `QB_SYNC_SCRIPTS.md` - QuickBooks sync scripts documentation
- `VERIFICATION_SCRIPTS.md` - Verification scripts guide

## 🚀 Usage

All scripts can be run with:

```bash
npx -y tsx src/scripts/[category]/[script-name].ts
```

### Examples

```bash
# Run a validation script
npx -y tsx src/scripts/checks/check-categories.ts

# Run a test
npx -y tsx src/scripts/tests/test-auth-e2e.ts

# Run a verification
npx -y tsx src/scripts/verify/verify-linting-system.ts

# Debug something
npx -y tsx src/scripts/debug/debug-api-logic.ts
```

## 📊 Statistics

- **Total organized scripts**: 257
- **Total categories**: 31
- **Uncategorized scripts**: 54 (in root directory)

## 🔍 Finding Scripts

Use `find` or `ls` to browse categories:

```bash
# List all categories
ls -la src/scripts/

# Find all check scripts
ls -la src/scripts/checks/

# Search for a specific script
find src/scripts -name "*category*"
```

## ⚠️ Note

Some scripts remain in the root directory as they don't fit standard categories or are special-purpose scripts (e.g., `seed.ts`, legacy `.js` files).