-- ============================================================
-- EcoPowerTech Finance Ledger — Verification Script
-- Usage: Run in psql session against Railway DB
-- Revision: 2026-03-18
-- ============================================================
-- TIP: Set :CUSTOMER_ID before running specific blocks.
--   \set CUSTOMER_ID 'cus_01ABC...'
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- BLOQUE 0: Estado general del sistema (sin filtro de cliente)
-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [0] ESTADO GENERAL DEL LEDGER ==='

-- CustomerPayments por status
SELECT
    status,
    COUNT(*)           AS count,
    SUM(amount)/100.0  AS total_usd
FROM customer_payment
GROUP BY status
ORDER BY status;

-- Últimos 10 pagos registrados
SELECT
    id,
    customer_id,
    source,
    type,
    method,
    amount/100.0  AS usd,
    status,
    received_at,
    reference
FROM customer_payment
ORDER BY received_at DESC
LIMIT 10;

-- PosInvoices por status
SELECT
    payment_status,
    COUNT(*)        AS count,
    SUM(total)/100.0 AS total_usd
FROM pos_invoice
GROUP BY payment_status
ORDER BY payment_status;


-- ─────────────────────────────────────────────────────────────
-- BLOQUE 1: Proceso Completo de Invoice con Depósito
-- Verifica que al crear un invoice con amount_paid, se generen:
--   1. pos_invoice (el invoice en sí)
--   2. customer_payment (status=applied)
--   3. payment_application (amarra payment con invoice)
--   4. invoice_payment (registro histórico interno)
-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [1] ULTIMO INVOICE CREADO + SUS PAGOS ==='

SELECT
    i.id                  AS invoice_id,
    i.invoice_number,
    i.customer_id,
    i.order_id,
    i.status,
    i.total/100.0         AS total_usd,
    i.amount_paid/100.0   AS amount_paid_usd,
    i.balance_due/100.0   AS balance_due_usd,
    i.payment_method,
    i.created_at
FROM pos_invoice i
ORDER BY i.created_at DESC
LIMIT 5;

\echo '-- Pagos en customer_payment para los últimos invoices --'
SELECT
    cp.id              AS payment_id,
    cp.customer_id,
    cp.amount/100.0    AS usd,
    cp.method,
    cp.status,
    cp.source,
    cp.reference,
    cp.received_at
FROM customer_payment cp
ORDER BY cp.received_at DESC
LIMIT 10;

\echo '-- PaymentApplications (puente payment ↔ invoice) --'
SELECT
    pa.id,
    pa.payment_id,
    pa.invoice_id,
    pa.order_id,
    pa.amount_applied/100.0  AS applied_usd,
    pa.applied_at,
    pa.voided_at
FROM payment_application pa
ORDER BY pa.applied_at DESC
LIMIT 10;

\echo '-- InvoicePayments (registro histórico interno) --'
SELECT
    ip.id,
    ip.invoice_id,
    ip.amount/100.0     AS usd,
    ip.payment_method,
    ip.notes,
    ip.paid_at
FROM invoice_payment ip
ORDER BY ip.paid_at DESC
LIMIT 10;


-- ─────────────────────────────────────────────────────────────
-- BLOQUE 2: Pago Parcial a un Invoice Existente
-- Verifica que POST /admin/invoices/:id/payments:
--   - Crea customer_payment (status=applied)
--   - Crea payment_application
--   - Crea invoice_payment
--   - Actualiza pos_invoice.amount_paid y balance_due
-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [2] PAGOS PARCIALES — ÚLTIMOS INVOICES CON BALANCE ==='

SELECT
    i.invoice_number,
    i.customer_id,
    i.total/100.0        AS total_usd,
    i.amount_paid/100.0  AS paid_usd,
    i.balance_due/100.0  AS pending_usd,
    i.status             AS inv_status,
    COUNT(ip.id)         AS num_payments
FROM pos_invoice i
LEFT JOIN invoice_payment ip ON ip.invoice_id = i.id
WHERE i.status NOT IN ('voided')
GROUP BY i.id
ORDER BY i.created_at DESC
LIMIT 10;


-- ─────────────────────────────────────────────────────────────
-- BLOQUE 3: Crédito en Cuenta (Store Credit) — Pago sin Factura
-- Verifica que un customer_payment status='available' exista
-- y que pueda ser aplicado a futuros invoices
-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [3] CRÉDITOS DISPONIBLES (STORE CREDIT) ==='

SELECT
    cp.id,
    cp.customer_id,
    cp.amount/100.0       AS total_usd,
    COALESCE(SUM(pa.amount_applied),0)/100.0  AS applied_usd,
    (cp.amount - COALESCE(SUM(pa.amount_applied),0))/100.0  AS remaining_usd,
    cp.method,
    cp.status,
    cp.source,
    cp.received_at
FROM customer_payment cp
LEFT JOIN payment_application pa ON pa.payment_id = cp.id AND pa.voided_at IS NULL
WHERE cp.status IN ('available','partially_applied')
GROUP BY cp.id
ORDER BY cp.received_at DESC;


-- ─────────────────────────────────────────────────────────────
-- BLOQUE 4: Pago Web (Subscriber) — e-commerce captura
-- Verifica que el subscriber finance-payment-captured.ts
-- haya creado customer_payment source='web', status='available'
-- con locked_order_id
-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [4] PAGOS WEB REGISTRADOS POR EL SUBSCRIBER ==='

SELECT
    cp.id,
    cp.customer_id,
    cp.amount/100.0       AS usd,
    cp.source,
    cp.status,
    cp.locked_order_id,
    cp.medusa_payment_id,
    cp.received_at
FROM customer_payment cp
WHERE cp.source = 'web'
ORDER BY cp.received_at DESC
LIMIT 10;


-- ─────────────────────────────────────────────────────────────
-- BLOQUE 5: Balance Neto por Cliente (equivalente al endpoint)
-- Formula: AR (balance_due en invoices) - Available Credit
-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [5] BALANCE NETO POR CLIENTE (TOP 20) ==='

WITH ar AS (
    SELECT
        customer_id,
        SUM(balance_due)/100.0  AS ar_usd
    FROM pos_invoice
    WHERE status NOT IN ('voided','paid')
      AND balance_due > 0
    GROUP BY customer_id
),
credits AS (
    SELECT
        cp.customer_id,
        SUM(
            cp.amount - COALESCE(
                (SELECT SUM(pa2.amount_applied) FROM payment_application pa2
                 WHERE pa2.payment_id = cp.id AND pa2.voided_at IS NULL),
                0
            )
        )/100.0  AS available_credit_usd
    FROM customer_payment cp
    WHERE cp.status IN ('available','partially_applied')
    GROUP BY cp.customer_id
)
SELECT
    COALESCE(ar.customer_id, credits.customer_id)  AS customer_id,
    COALESCE(ar.ar_usd, 0)                          AS ar_outstanding,
    COALESCE(credits.available_credit_usd, 0)       AS available_credit,
    COALESCE(ar.ar_usd, 0) - COALESCE(credits.available_credit_usd, 0)  AS net_balance
FROM ar
FULL OUTER JOIN credits ON credits.customer_id = ar.customer_id
ORDER BY net_balance DESC
LIMIT 20;


-- ─────────────────────────────────────────────────────────────
-- BLOQUE 6: Integridad — Pagos huérfanos (sin customer_payment)
-- Detecta invoice_payments sin su correspondiente customer_payment
-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [6] CHEQUEO INTEGRIDAD: PAGOS HUERFANOS ==='

SELECT
    ip.id            AS invoice_payment_id,
    ip.invoice_id,
    ip.amount/100.0  AS usd,
    ip.paid_at
FROM invoice_payment ip
WHERE NOT EXISTS (
    SELECT 1
    FROM payment_application pa
    JOIN customer_payment cp ON cp.id = pa.payment_id
    WHERE pa.invoice_id = ip.invoice_id
)
ORDER BY ip.paid_at DESC;

\echo 'Si esta consulta no regresa filas = BIEN (no hay huérfanos).'


-- ─────────────────────────────────────────────────────────────
-- BLOQUE 7: Idempotencia Web — Pagos duplicados de subscriber
-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [7] CHEQUEO IDEMPOTENCIA WEB: medusa_payment_id DUPLICADOS ==='

SELECT
    medusa_payment_id,
    COUNT(*) AS count
FROM customer_payment
WHERE medusa_payment_id IS NOT NULL
GROUP BY medusa_payment_id
HAVING COUNT(*) > 1;

\echo 'Si esta consulta no regresa filas = BIEN (no hay duplicados).'

\echo ''
\echo '=== FIN DEL SCRIPT DE VERIFICACION ==='
