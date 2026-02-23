#!/usr/bin/env tsx
/**
 * debug-order-totals.ts
 * 
 * Diagnóstico: ¿Por qué las órdenes "Authorized" salen vacías en el Admin Panel 
 * de Railway y las canceladas salen con montos negativos?
 *
 * Uso: npx -y tsx src/scripts/debug/debug-order-totals.ts
 */

import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const DB_URL = process.env.DATABASE_URL;

interface OrderRow {
    id: string;
    display_id: number;
    status: string;
    payment_status: string;
    fulfillment_status: string;
    currency_code: string;
    // Stored raw totals (in cents as integers or null)
    raw_original_order_total: number | null;
    raw_subtotal: number | null;
    raw_shipping_total: number | null;
    raw_tax_total: number | null;
    raw_discount_total: number | null;
    raw_discount_tax_total: number | null;
    raw_credit_line_total: number | null;
    raw_gift_card_total: number | null;
    // Derived totals in summary (stored as JSON or computed)
    metadata: any;
    created_at: string;
    region_id: string | null;
}

interface PaymentRow {
    id: string;
    order_id: string;
    amount: number;
    authorized_amount: number | null;
    captured_amount: number;
    refunded_amount: number;
    status: string;
    currency_code: string;
}

interface RefundRow {
    id: string;
    order_id: string;
    amount: number;
    reason: string | null;
    note: string | null;
    created_at: string;
}

async function main() {
    if (!DB_URL) {
        console.error('❌ DATABASE_URL not set in .env');
        process.exit(1);
    }

    const client = new Client({ connectionString: DB_URL });

    try {
        await client.connect();
        console.log('✅ Conectado a:', DB_URL.split('@')[1]?.split('/')[0] || 'DB');
        console.log('');

        // ─── 1. Ver las órdenes con sus totales raw ────────────────────────────
        console.log('═══════════════════════════════════════════════════════════');
        console.log('📋 ÓRDENES — Campos de totales en DB');
        console.log('═══════════════════════════════════════════════════════════');

        const ordersResult = await client.query<OrderRow>(`
      SELECT 
        o.id,
        o.display_id,
        o.status,
        o.payment_status,
        o.fulfillment_status,
        o.currency_code,
        o.region_id,
        o.raw_original_order_total,
        o.raw_subtotal,
        o.raw_shipping_total,
        o.raw_tax_total,
        o.raw_discount_total,
        o.raw_gift_card_total,
        o.metadata,
        o.created_at
      FROM "order" o
      ORDER BY o.display_id DESC
      LIMIT 15
    `);

        for (const order of ordersResult.rows) {
            const total = order.raw_original_order_total;
            const totalDollars = total !== null ? (total / 100).toFixed(2) : 'NULL';

            console.log(`\n  Order #${order.display_id} [${order.id.slice(-6)}]`);
            console.log(`  Status: ${order.status} | Payment: ${order.payment_status} | Fulfillment: ${order.fulfillment_status}`);
            console.log(`  Currency: ${order.currency_code} | Region: ${order.region_id || 'NULL ⚠️'}`);
            console.log(`  raw_original_order_total: ${total !== null ? total : 'NULL'} → $${totalDollars}`);
            console.log(`  raw_subtotal:             ${order.raw_subtotal ?? 'NULL'}`);
            console.log(`  raw_shipping_total:       ${order.raw_shipping_total ?? 'NULL'}`);
            console.log(`  raw_tax_total:            ${order.raw_tax_total ?? 'NULL'}`);
            console.log(`  raw_discount_total:       ${order.raw_discount_total ?? 'NULL'}`);
        }

        // ─── 2. Ver los payment records ────────────────────────────────────────
        console.log('\n');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('💳 PAYMENTS — authorized_amount vs captured_amount vs refunded_amount');
        console.log('═══════════════════════════════════════════════════════════');

        // Try payment_collection or payment table
        let paymentsResult;
        try {
            paymentsResult = await client.query(`
        SELECT 
          p.id,
          p.order_id,
          o.display_id,
          o.status as order_status,
          o.payment_status,
          p.amount,
          p.authorized_amount,
          p.captured_amount,
          p.refunded_amount,
          p.status as payment_status_raw,
          p.currency_code
        FROM payment p
        JOIN "order" o ON o.id = p.order_id
        ORDER BY o.display_id DESC
        LIMIT 15
      `);

            for (const pay of paymentsResult.rows) {
                console.log(`\n  Order #${pay.display_id} | Payment: ${pay.id.slice(-6)}`);
                console.log(`  Order Status: ${pay.order_status} | Payment Status: ${pay.payment_status}`);
                console.log(`  amount:           $${(pay.amount / 100).toFixed(2)}`);
                console.log(`  authorized_amount:$${pay.authorized_amount !== null ? (pay.authorized_amount / 100).toFixed(2) : 'NULL'}`);
                console.log(`  captured_amount:  $${(pay.captured_amount / 100).toFixed(2)}`);
                console.log(`  refunded_amount:  $${(pay.refunded_amount / 100).toFixed(2)}`);

                // Admin formula: paid_total - refunded_total
                const paid = pay.captured_amount || 0;
                const refunded = pay.refunded_amount || 0;
                const adminTotal = (paid - refunded) / 100;
                console.log(`  → Admin "Order Total" = captured - refunded = $${adminTotal.toFixed(2)}`);
            }
        } catch (e: any) {
            console.log('  ⚠️  Tabla payment no accesible directamente, intentando payment_collection...');

            const pcResult = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name LIKE '%payment%'
        ORDER BY table_name
      `);
            console.log('  Tablas de payment disponibles:', pcResult.rows.map(r => r.table_name).join(', '));
        }

        // ─── 3. Ver refunds ────────────────────────────────────────────────────
        console.log('\n');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('↩️  REFUNDS — Por qué salen negativos en admin');
        console.log('═══════════════════════════════════════════════════════════');

        try {
            const refundsResult = await client.query(`
        SELECT 
          r.id,
          r.order_id,
          o.display_id,
          o.status as order_status,
          o.payment_status,
          r.amount,
          r.reason,
          r.note,
          r.created_at
        FROM refund r
        JOIN "order" o ON o.id = r.order_id
        ORDER BY o.display_id DESC, r.created_at DESC
        LIMIT 20
      `);

            if (refundsResult.rows.length === 0) {
                console.log('  (No hay refunds en la tabla refund)');
            } else {
                for (const ref of refundsResult.rows) {
                    console.log(`\n  Order #${ref.display_id} | Order Status: ${ref.order_status} | Payment: ${ref.payment_status}`);
                    console.log(`  Refund amount: $${(ref.amount / 100).toFixed(2)} | Reason: ${ref.reason || 'NULL'} | Note: ${ref.note || 'NULL'}`);
                }
            }
        } catch (e: any) {
            console.log('  ⚠️  Tabla refund no accesible.');

            const tablesResult = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name LIKE '%refund%'
        ORDER BY table_name
      `);
            console.log('  Tablas de refund disponibles:', tablesResult.rows.map(r => r.table_name).join(', '));
        }

        // ─── 4. Summary de la situación ────────────────────────────────────────
        console.log('\n');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('🧮 ANÁLISIS: ¿Por qué Authorized salen vacíos?');
        console.log('═══════════════════════════════════════════════════════════');

        const authorizedOrders = await client.query(`
      SELECT 
        o.display_id,
        o.status,
        o.payment_status,
        o.raw_original_order_total,
        o.currency_code,
        COUNT(p.id) as payment_count,
        SUM(p.amount) as total_payment_amount,
        SUM(p.authorized_amount) as total_authorized,
        SUM(p.captured_amount) as total_captured,
        SUM(p.refunded_amount) as total_refunded
      FROM "order" o
      LEFT JOIN payment p ON p.order_id = o.id
      WHERE o.payment_status = 'authorized'
      GROUP BY o.id, o.display_id, o.status, o.payment_status, o.raw_original_order_total, o.currency_code
      ORDER BY o.display_id DESC
    `);

        console.log('\n  Órdenes con payment_status = "authorized":');
        for (const row of authorizedOrders.rows) {
            const rawTotal = row.raw_original_order_total;
            const captured = row.total_captured;
            const refunded = row.total_refunded;
            const adminFormula = captured !== null && refunded !== null
                ? `$${((captured - refunded) / 100).toFixed(2)}`
                : 'NULO (sin payment record)';

            console.log(`\n  #${row.display_id}: status=${row.status} | payment=${row.payment_status}`);
            console.log(`  raw_original_order_total = ${rawTotal ?? 'NULL'} ($${rawTotal ? (rawTotal / 100).toFixed(2) : '?'})`);
            console.log(`  Payments encontrados: ${row.payment_count}`);
            console.log(`  authorized_amount total: ${row.total_authorized ?? 'NULL'}`);
            console.log(`  captured_amount total:   ${row.total_captured ?? 'NULL'} → sin captura = 0`);
            console.log(`  refunded_amount total:   ${row.total_refunded ?? 'NULL'}`);
            console.log(`  Admin fórmula (captured - refunded): ${adminFormula}`);
            console.log(`  ← Por eso el admin muestra "—" (captured=0, refunded=0 → $0 en Authorized)`);
        }

        console.log('\n');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('✅ DIAGNÓSTICO COMPLETADO');
        console.log('═══════════════════════════════════════════════════════════');

    } catch (err: any) {
        console.error('❌ Error:', err.message);

        // Si falla por columnas que no existen, mostrar las columnas reales
        if (err.message.includes('column') || err.message.includes('does not exist')) {
            console.log('\n🔍 Revisando columnas reales de la tabla "order"...');
            try {
                const colResult = await client.query(`
          SELECT column_name, data_type 
          FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'order'
          AND column_name LIKE '%total%' OR column_name LIKE '%raw%' OR column_name LIKE '%amount%'
          ORDER BY column_name
        `);
                console.log('Columnas relacionadas con totales/amounts:');
                for (const col of colResult.rows) {
                    console.log(`  ${col.column_name}: ${col.data_type}`);
                }
            } catch (e2: any) {
                console.error('Error secundario:', e2.message);
            }
        }
    } finally {
        await client.end();
    }
}

main();
