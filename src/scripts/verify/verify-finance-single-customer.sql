-- ============================================================
-- EcoPowerTech Finance — Detalle Financiero de UN Cliente
-- Uso: psql "postgresql://..." -v CUSTOMER_ID='cus_01...'
--      \i backend/src/scripts/verify/verify-finance-single-customer.sql
-- ============================================================
-- Ejemplo de uso desde terminal:
--   PGPASSWORD=xxx psql "postgresql://postgres:...@interchange.proxy.rlwy.net:34919/railway" \
--     -v CUSTOMER_ID="'cus_TUCLIENTE'" \
--     -f backend/src/scripts/verify/verify-finance-single-customer.sql
-- ============================================================

\echo ''
\echo '==========================================='
\echo ' ESTADO FINANCIERO COMPLETO DEL CLIENTE'
\echo '==========================================='

-- A. Todos sus invoices
\echo ''
\echo '--- A. POS INVOICES ---'
SELECT
    invoice_number,
    order_id,
    status,
    total/100.0        AS total_usd,
    amount_paid/100.0  AS paid_usd,
    balance_due/100.0  AS balance_usd,
    payment_method,
    issued_at
FROM pos_invoice
WHERE customer_id = :'CUSTOMER_ID'
ORDER BY issued_at DESC;

-- B. Todos sus CustomerPayments
\echo ''
\echo '--- B. CUSTOMER PAYMENTS (LEDGER ENTRIES) ---'
SELECT
    id,
    amount/100.0   AS usd,
    method,
    source,
    status,
    reference,
    locked_order_id,
    received_at
FROM customer_payment
WHERE customer_id = :'CUSTOMER_ID'
ORDER BY received_at DESC;

-- C. Todas sus PaymentApplications
\echo ''
\echo '--- C. PAYMENT APPLICATIONS (PUENTES PAYMENT-INVOICE) ---'
SELECT
    pa.id,
    pa.payment_id,
    pa.invoice_id,
    pa.order_id,
    pa.amount_applied/100.0  AS applied_usd,
    pa.applied_at,
    pa.voided_at
FROM payment_application pa
JOIN customer_payment cp ON cp.id = pa.payment_id
WHERE cp.customer_id = :'CUSTOMER_ID'
ORDER BY pa.applied_at DESC;

-- D. Balance Neto calculado igual que el endpoint
\echo ''
\echo '--- D. BALANCE NETO (MISMO CALCULO QUE EL ENDPOINT) ---'
WITH ar AS (
    SELECT COALESCE(SUM(balance_due), 0) AS ar_cents
    FROM pos_invoice
    WHERE customer_id = :'CUSTOMER_ID'
      AND status NOT IN ('voided','paid')
      AND balance_due > 0
),
credits AS (
    SELECT COALESCE(SUM(
        cp.amount - COALESCE(
            (SELECT SUM(pa.amount_applied) FROM payment_application pa
             WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL),
            0
        )
    ), 0) AS credit_cents
    FROM customer_payment cp
    WHERE cp.customer_id = :'CUSTOMER_ID'
      AND cp.status IN ('available','partially_applied')
)
SELECT
    ar.ar_cents/100.0      AS ar_outstanding_usd,
    credits.credit_cents/100.0  AS available_credit_usd,
    (ar.ar_cents - credits.credit_cents)/100.0 AS net_balance_usd,
    CASE 
        WHEN (ar.ar_cents - credits.credit_cents) > 0 THEN '🔴 DEBE DINERO'
        WHEN (ar.ar_cents - credits.credit_cents) < 0 THEN '🟢 TIENE CREDITO'
        ELSE '⚪ BALANCE CERO'
    END AS status_label
FROM ar, credits;

\echo ''
\echo '=== FIN DEL REPORTE INDIVIDUAL ==='
