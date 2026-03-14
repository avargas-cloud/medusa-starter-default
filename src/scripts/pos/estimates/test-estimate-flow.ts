/**
 * test-estimate-flow.ts — Draft Order / Estimate Flow (Remote)
 *
 * Prueba el flujo de B2B Draft Orders:
 *   1. Crear Estimate en QB (Draft Order creado en Medusa Admin)
 *   2. Convertir Estimate → Sales Order (Draft confirmado como Order)
 *
 * Usage:
 *   cd backend
 *   npx ts-node --project tsconfig.json scripts/qb/test-estimate-flow.ts
 */

import { qbRequest, waitForOp, DEFAULT_CUSTOMER_LISTID, DEFAULT_PRODUCT_LISTID, DEFAULT_SITE_LISTID } from './config';

const CUSTOMER_LISTID = process.env.QB_TEST_CUSTOMER ?? DEFAULT_CUSTOMER_LISTID;
const PRODUCT_LISTID = process.env.QB_TEST_PRODUCT ?? DEFAULT_PRODUCT_LISTID;
const SITE_LISTID = process.env.QB_TEST_SITE ?? DEFAULT_SITE_LISTID;
const TEST_LABEL = `Draft Test ${new Date().toISOString().slice(0, 10)}`;

async function main() {
    console.log('\n=== TEST: ESTIMATE → SALES ORDER FLOW (Remote) ===');
    console.log(`   Customer: ${CUSTOMER_LISTID}`);
    console.log(`   Product:  ${PRODUCT_LISTID}\n`);

    // ─── STEP 1: Create Estimate ──────────────────────────────────────────────
    console.log('[1/2] Creating Estimate (Draft Order)...');
    const estRes = await qbRequest('POST', '/api/estimates', {
        customerId: CUSTOMER_LISTID,
        date: new Date().toISOString().split('T')[0],
        salesTaxCode: 'Sale Tax 7%',
        memo: `Draft — ${TEST_LABEL}`,
        items: [{
            productId: PRODUCT_LISTID,
            quantity: 2,
            price: 49.99,
            desc: 'Estimate test item',
        }],
    });

    if (!estRes.operationId) throw new Error(`Estimate queue failed: ${JSON.stringify(estRes)}`);
    const estOp = await waitForOp(estRes.operationId, 'Estimate Creation');
    const estTxnId = estOp.txnId;
    const estRefNumber = estOp.refNumber;
    console.log(`   TxnID:     ${estTxnId}`);
    console.log(`   RefNumber: ${estRefNumber}`);
    console.log(`\n   → Check QB Desktop — Estimate ${estRefNumber} should be visible`);

    // ─── STEP 2: Convert Estimate → Sales Order ───────────────────────────────
    console.log('\n[2/2] Converting Estimate → Sales Order...');
    console.log('   (Simulates Medusa Draft Order → confirmed Order)');

    const soRes = await qbRequest('POST', '/api/sales-orders/convert-from-estimate', {
        estimateTxnId: estTxnId,
        customerId: CUSTOMER_LISTID,
        date: new Date().toISOString().split('T')[0],
        salesTaxCode: 'Sale Tax 7%',
        memo: `From Estimate ${estRefNumber} — ${TEST_LABEL}`,
        items: [{
            productId: PRODUCT_LISTID,
            quantity: 2,
            price: 49.99,
            desc: 'Estimate test item',
            siteId: SITE_LISTID,      // ← required for SO in QB Enterprise
        }],
    });

    if (!soRes.operationId) throw new Error(`Convert SO queue failed: ${JSON.stringify(soRes)}`);
    const soOp = await waitForOp(soRes.operationId, 'Convert Estimate → SO');

    console.log('\n✅ ESTIMATE FLOW COMPLETE!');
    console.log(`   Estimate:    ${estTxnId}  (Ref: ${estRefNumber})`);
    console.log(`   Sales Order: ${soOp.txnId}  (Ref: ${soOp.refNumber})`);
    console.log('\n   → Verify in QB Desktop that Estimate is "Converted" and SO exists');
}

main().catch(e => { console.error('\n❌ FLOW FAILED:', e.message); process.exit(1); });
