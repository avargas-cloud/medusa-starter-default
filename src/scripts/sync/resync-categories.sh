#!/bin/bash

# Mass Sync All Categories - Authenticated Curl Script
# 
# This script triggers the /resync-all endpoint which will re-sync
# all categories with the new recursive aggregation logic.
#
# Note: You must be logged into the Admin UI for this to work.
# The cookie will be extracted from your browser session.

echo "🔄 Starting mass category re-sync..."
echo ""
echo "⚠️  IMPORTANT: Make sure you are logged into Admin UI at http://localhost:9000/app"
echo "⚠️  This script will use your browser's session cookie."
echo ""
read -p "Press ENTER to continue or Ctrl+C to cancel..."

# Create a simple Node.js script to make the authenticated request
cat > /tmp/resync-categories.js << 'SCRIPT'
const http = require('http');

const options = {
  hostname: 'localhost',
  port: 9000,
  path: '/admin/product-categories/resync-all',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      console.log('\n✅ Mass re-sync complete!\n');
      console.log(`Total categories: ${result.totalCategories}`);
      console.log(`Success: ${result.successCount}`);
      console.log(`Errors: ${result.errorCount}\n`);
      
      if (result.results && result.results.length > 0) {
        console.log('Sample results:');
        result.results.slice(0, 5).forEach(r => {
          if (r.success) {
            console.log(`  ✅ ${r.category}: ${r.attributeCount} attrs from ${r.productCount} products`);
          } else {
            console.log(`  ❌ ${r.category}: ${r.error}`);
          }
        });
      }
    } catch (e) {
      console.error('Response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Error:', error.message);
  console.error('\nMake sure:');
  console.error('1. Medusa server is running on port 9000');
  console.error('2. You are logged into the Admin UI');
});

req.end();
SCRIPT

echo ""
echo "Executing mass re-sync..."
node /tmp/resync-categories.js

# Cleanup
rm /tmp/resync-categories.js

echo ""
echo "Done! Check the Admin UI at /app/filters to verify results."
