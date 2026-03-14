/**
 * test-invoice.ts — Invoice Creation + Apply Payment (Remote)
 *
 * Dos modos de uso:
 *
 *   Modo A — pasas el TxnID del Sales Order existente:
 *     QB_SO_TXN_ID=1B60F5-XXXXXXXXX npx ts-node --project tsconfig.json scripts/qb/test-invoice.ts
 *
 *   Modo B — crea el SO automáticamente y luego la Invoice:
 *     npx ts-node --project tsconfig.json scripts/qb/test-invoice.ts
 *
 * En ambos modos: crea Invoice → Receive Payment → aplica pago a la Invoice.
 *
 * Usage:
 *   cd backend
 *   npx ts-node --project tsconfig.json scripts/qb/test-invoice.ts
 */

import { qbRequest, waitForOp, DEFAULT_CUSTOMER_LISTID, DEFAULT_PRODUCT_LISTID, DEFAULT_SITE_LISTID } from './config';

const CUSTOMER_LISTID = process.env.QB_TEST_CUSTOMER ?? DEFAULT_CUSTOMER_LISTID;
const PRODUCT_LISTID = process.env.QB_TEST_PRODUCT ?? DEFAULT_PRODUCT_LISTID;
const SITE_LISTID = process.env.QB_TEST_SITE ?? DEFAULT_SITE_LISTID;
const INVOICE_AMOUNT = 49.99;

async function createSalesOrder(): Promise<{ txnId: string; refNumber: string }> {
    console.log('   Creating Sales Order first...');
    const soRes = await qbRequest('POST', '/api/sales-orders', {
        customerId: CUSTOMER_LISTID,
        date: new Date().toISOString().split('T')[0],
        salesTaxCode: 'Sale Tax 7%',
        memo: `Auto-SO for Invoice test ${new Date().toLocaleTimeString()}`,
        items: [{
            productId: PRODUCT_LISTID,
            quantity: 1,
            price: INVOICE_AMOUNT,
            desc: 'Invoice test item',
            siteId: SITE_LISTID,
        }],
    });
    if (!soRes.operationId) throw new Error(`SO queue failed: ${JSON.stringify(soRes)}`);
    const soOp = await waitForOp(soRes.operationId, 'Sales Order (auto)');
    return { txnId: soOp.txnId, refNumber: soOp.refNumber };
}

async function main() {
    console.log('\n=== TEST: INVOICE CREATION + PAYMENT (Remote) ===\n');

    // ─── Get or create Sales Order ────────────────────────────────────────────
    let soTxnId = process.env.QB_SO_TXN_ID ?? '';
    let soRefNumber = '';

    if (soTxnId) {
        console.log(`[0/3] Using existing Sales Order: ${soTxnId}`);
    } else {
        console.log('[0/3] No QB_SO_TXN_ID provided — creating Sales Order automatically...');
        const so = await createSalesOrder();
        soTxnId = so.txnId;
        soRefNumber = so.refNumber;
        console.log(`   SO: ${soTxnId}  (Ref: ${soRefNumber})`);
    }

    // ─── STEP 1: Create Invoice linked to Sales Order ─────────────────────────
    console.log('\n[1/3] Creating Invoice linked to Sales Order...');
    const invRes = await qbRequest('POST', '/api/invoices', {
        customerId: CUSTOMER_LISTID,
        LinkToTxnID: soTxnId,
        memo: `Invoice for SO ${soRefNumber || soTxnId} — ${new Date().toLocaleDateString()}`,
    });

    if (!invRes.operationId) throw new Error(`Invoice queue failed: ${JSON.stringify(invRes)}`);
    const invOp = await waitForOp(invRes.operationId, 'Invoice Creation');

    const invTxnId = invOp.txnId;
    const invRefNumber = invOp.refNumber;
    const invRet = (invOp.result?.QBXML?.QBXMLMsgsRs ?? invOp.result?.QBXMLMsgsRs)
        ?.InvoiceAddRs?.InvoiceRet;
    const balance = invRet?.BalanceRemaining ?? 'N/A';

    console.log(`   TxnID:     ${invTxnId}`);
    console.log(`   RefNumber: ${invRefNumber}`);
    console.log(`   Balance:   $${balance}`);

    // ─── STEP 2: Receive Payment ──────────────────────────────────────────────
    console.log('\n[2/3] Receiving Payment for Invoice...');
    const payRes = await qbRequest('POST', '/api/payments', {
        customerId: CUSTOMER_LISTID,
        amount: INVOICE_AMOUNT,
        paymentMethod: 'Visa',
        refNumber: `PAY-${Date.now().toString().slice(-6)}`,
        invoiceId: invTxnId,     // ← link directly to invoice (QB auto-applies)
        memo: `Payment for Invoice ${invRefNumber}`,
    });

    if (!payRes.operationId) throw new Error(`Payment queue failed: ${JSON.stringify(payRes)}`);
    const payOp = await waitForOp(payRes.operationId, 'Receive Payment');
    const payTxnId = payOp.txnId;
    console.log(`   TxnID:     ${payTxnId}`);

    // ─── STEP 3: Verify ───────────────────────────────────────────────────────
    console.log('\n[3/3] Querying Invoice to verify final balance...');
    const queryRes = await qbRequest('GET', `/api/invoices/${invTxnId}`);
    if (queryRes.operationId) {
        const queryOp = await waitForOp(queryRes.operationId, 'Invoice Query');
        const qRet = (queryOp.result?.QBXML?.QBXMLMsgsRs ?? queryOp.result?.QBXMLMsgsRs)
            ?.InvoiceQueryRs?.InvoiceRet;
        const finalBalance = qRet?.BalanceRemaining ?? 'N/A';
        console.log(`   Balance After Payment: $${finalBalance}`);
        if (Number(finalBalance) === 0 || finalBalance === '0.00') {
            console.log('   ✅ Invoice fully paid!');
        } else {
            console.log('   ⚠️  Balance not zero — check if payment applied correctly in QB');
        }
    } else {
        console.log('   (Query not supported — check QB Desktop manually)');
    }

    // ─── Summary ──────────────────────────────────────────────────────────────
    console.log('\n=== SUMMARY ===');
    console.log(`   Sales Order: ${soTxnId}${soRefNumber ? ` (Ref: ${soRefNumber})` : ''}`);
    console.log(`   Invoice:     ${invTxnId}  (Ref: ${invRefNumber})`);
    console.log(`   Payment:     ${payTxnId}`);
    console.log('\n   ✅ Invoice flow complete — check QB Desktop!');
}

main().catch(e => { console.error('\n❌ TEST FAILED:', e.message); process.exit(1); });
