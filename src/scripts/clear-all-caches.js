#!/usr/bin/env node
/**
 * Clear all caches and force refresh
 * Run with: node src/scripts/clear-all-caches.js
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function clearCaches() {
    console.log('🧹 Clearing all caches...\n');

    try {
        // 1. Clear Redis cache
        console.log('1️⃣  Clearing Redis cache...');
        try {
            await execAsync('docker exec -it medusa-redis redis-cli FLUSHALL');
            console.log('   ✅ Redis cache cleared\n');
        } catch (redisError) {
            console.log('   ⚠️  Could not clear Redis (may not be using Docker)');
            console.log('   💡 Try manually: redis-cli FLUSHALL\n');
        }

        // 2. Restart backend to clear in-memory cache
        console.log('2️⃣  Backend restart recommended');
        console.log('   Run: pkill -f "medusa start" && npm run dev\n');

        // 3. Clear browser cache
        console.log('3️⃣  Clear browser cache:');
        console.log('   - Logout from storefront');
        console.log('   - Hard refresh (Ctrl+Shift+R)');
        console.log('   - Login again\n');

        console.log('✅ Cache clearing steps completed!');

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

clearCaches();
