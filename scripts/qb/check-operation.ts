/**
 * check-operation.ts — Check QB Operation Status (Remote)
 *
 * Útil para consultar el estado de un operationId que quedó pendiente.
 * Pasa el operationId como argumento CLI.
 *
 * Usage:
 *   cd backend
 *   npx ts-node --project tsconfig.json scripts/qb/check-operation.ts <operationId>
 *
 * Example:
 *   npx ts-node --project tsconfig.json scripts/qb/check-operation.ts 50643fe7-2a39-4ebc-86d6-6c8e7a2e101a
 */

import { BRIDGE_URL, qbRequest } from './config';

async function main() {
    const opId = process.argv[2];

    if (!opId) {
        console.error('❌ Usage: npx ts-node scripts/qb/check-operation.ts <operationId>');
        process.exit(1);
    }

    console.log(`\n📡 Bridge: ${BRIDGE_URL}`);
    console.log(`🔍 Checking operation: ${opId}\n`);

    const res = await qbRequest('GET', `/api/sync/status/${opId}`);
    const op = res.operation ?? res;

    const statusIcon = {
        completed: '✅',
        failed: '❌',
        pending: '⏳',
        processing: '🔄',
    }[op.status as string] ?? '❓';

    console.log(`${statusIcon} Status:    ${op.status}`);

    if (op.status === 'completed') {
        console.log(`   TxnID:     ${op.txnId ?? 'N/A'}`);
        console.log(`   RefNumber: ${op.refNumber ?? 'N/A'}`);
        if (op.result) {
            console.log('\n   Raw result:');
            console.log(JSON.stringify(op.result, null, 2));
        }
    } else if (op.status === 'failed') {
        console.log(`   Error:     ${JSON.stringify(op.error)}`);
    } else {
        console.log('   → Operation is still in queue. Try again in a few seconds.');
    }
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
