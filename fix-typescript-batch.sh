#!/bin/bash
# Mass TypeScript error fixes
set -e

echo "🔧 Applying TypeScript fixes..."

# Fix 1: Unused 'req' parameters - prefix with underscore
echo "Fixing unused 'req' parameters..."
sed -i 's/async function POST(\s*req:/async function POST(_req:/g' \
  src/api/admin/quickbooks/check/customers/route.ts \
  src/api/admin/quickbooks/config/route.ts \
  src/api/store/auth/sendgrid-debug/route.ts \
  src/api/store/auth/register/case3-legacy-customer.ts \
  src/api/store/custom/route.ts

# Fix 2: Unused imports - prefix or remove
echo "Fixing unused imports..."
sed -i 's/import { Modules }/import { Modules as _Modules }/g' \
  src/api/admin/products/bulk-assign-prices/route.ts \
  src/api/store/auth/register/case3-legacy-customer.ts

sed -i 's/import { Knex }/import type { Knex as _Knex }/g' \
  src/api/store/_shared/product-enrichment.ts

# Fix 3: Unused 'timestamp' variable
echo "Fixing unused timestamp..."
sed -i 's/const \[customerId, timestamp\]/const [customerId, _timestamp]/g' \
  src/api/store/auth/activate/route.ts

# Fix 4: Unused 'basePath' variable  
echo "Fixing unused basePath..."
sed -i 's/const basePath/const _basePath/g' \
  src/api/middlewares.ts

echo "✅ Batch fixes applied"
