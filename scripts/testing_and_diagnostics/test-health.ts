/**
 * test-health.ts — QB Bridge Health Check (Remote)
 *
 * Verifica que el bridge esté corriendo y reporta el estado de la cola.
 *
 * Usage:
 *   cd backend
 *   npx ts-node --project tsconfig.json scripts/qb/test-health.ts
 */

import { BRIDGE_URL, qbRequest } from './config';

async function main() {
    console.log(`\n📡 Pinging QB Bridge at: ${BRIDGE_URL}/health\n`);

    try {
        const result = await qbRequest('GET', '/health');

        if (result.status === 'healthy') {
            console.log('✅ BRIDGE ONLINE!');
            console.log(`   Status:     ${result.status}`);
            console.log(`   Queue:      ${result.queueSize ?? 0} item(s) pending`);
            console.log(`   Uptime:     ${result.uptime ? Math.floor(result.uptime) + 's' : 'N/A'}`);
        } else {
            console.log('⚠️  Bridge responded but status is unexpected:');
            console.log(result);
        }
    } catch (e: any) {
        console.error('❌ BRIDGE UNREACHABLE:', e.message);
        console.error('   → Is the tunnel running? (localtunnel / Cloudflare)');
        console.error('   → Is PM2 running the bridge on the Windows server?');
    }
}

main();
