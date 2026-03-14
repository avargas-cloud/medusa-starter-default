/**
 * test-sales-receipt.ts — Sales Receipt Creation (Remote)
 *
 * Sales Receipt = venta inmediata al contado (POS / tienda física).
 * NO requiere Sales Order ni Invoice — registra la venta y el pago en un solo paso.
 *
 * Útil para el admin panel de vendedores de tienda.
 *
 * Diferencia clave vs Sales Order:
 *   Sales Order → cliente pide, se fulfilla, luego se factura
 *   Sales Receipt → cliente paga en el momento, done ✅
 *
 * Usage:
 *   cd backend
 *   npx ts-node --project tsconfig.json scripts/qb/test-sales-receipt.ts
 *
 * Env vars opcionales:
 *   QB_TEST_CUSTOMER=<listId>   Override customer
 *   QB_TEST_PRODUCT=<listId>    Override product
 *   QB_PAYMENT_METHOD=Cash|Visa|MasterCard|Check   (default: Cash)
 */

import { qbRequest, waitForOp, DEFAULT_CUSTOMER_LISTID, DEFAULT_PRODUCT_LISTID } from './config';

const CUSTOMER_LISTID = process.env.QB_TEST_CUSTOMER ?? DEFAULT_CUSTOMER_LISTID;
const PRODUCT_LISTID = process.env.QB_TEST_PRODUCT ?? DEFAULT_PRODUCT_LISTID;
const PAYMENT_METHOD = process.env.QB_PAYMENT_METHOD ?? 'Cash';
const AMOUNT = Number(process.env.QB_AMOUNT) || 49.99;

async function main() {
    console.log('\n=== TEST: SALES RECEIPT (Immediate Cash Sale) ===');
    console.log(`   Customer:       ${CUSTOMER_LISTID}`);
    console.log(`   Product:        ${PRODUCT_LISTID}`);
    console.log(`   Payment Method: ${PAYMENT_METHOD}`);
    console.log(`   Amount:         $${AMOUNT}\n`);

    const res = await qbRequest('POST', '/api/sales-receipts', {
        customerId: CUSTOMER_LISTID,
        date: new Date().toISOString().split('T')[0],
        paymentMethod: PAYMENT_METHOD,
        templateRef: 'Sales Receipt Ecopowerte',
        memo: `Store Sale — ${new Date().toLocaleString()}`,
        items: [{
            productId: PRODUCT_LISTID,
            quantity: 1,
            rate: AMOUNT,
            desc: `Test immediate sale (${PAYMENT_METHOD})`,
        }],
    });

    if (!res.operationId) {
        throw new Error(`Sales Receipt queue failed: ${JSON.stringify(res)}`);
    }

    console.log(`   OperationID: ${res.operationId}`);
    const op = await waitForOp(res.operationId, 'Sales Receipt Creation');

    const ret = (op.result?.QBXML?.QBXMLMsgsRs ?? op.result?.QBXMLMsgsRs)
        ?.SalesReceiptAddRs?.SalesReceiptRet;

    console.log('\n✅ Sales Receipt Created!');
    console.log(`   TxnID:     ${op.txnId ?? ret?.TxnID}`);
    console.log(`   RefNumber: ${op.refNumber ?? ret?.RefNumber}`);
    console.log(`   Total:     $${ret?.TotalAmount ?? AMOUNT}`);
    console.log('\n   → Check QB Desktop — should appear under "Sales Receipts"');
    console.log('   → No pending invoice — sale & payment recorded in one shot ✅');
}

main().catch(e => { console.error('\n❌ TEST FAILED:', e.message); process.exit(1); });
