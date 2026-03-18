-- ============================================================
-- EcoPowerTech — Verificación de Invoice + Fulfillment Nativo
-- Modo de uso en psql:
--   \set ORDER_DISPLAY_ID 1122
--   \i backend/src/scripts/verify/verify-invoice-and-fulfillment.sql
-- ============================================================

-- Paso 0: Resolver el order_id real de Medusa a partir del display_id
SELECT
    id          AS order_id,
    customer_id AS order_customer_id,
    status      AS order_status,
    display_id  AS order_display_id
FROM "order"
WHERE display_id = :ORDER_DISPLAY_ID
  AND deleted_at IS NULL
LIMIT 1
\gset

\echo ''
\echo '=== [A] ORDEN EN MEDUSA (Estado nativo) ==='
SELECT
    id, display_id, status, payment_status, fulfillment_status, customer_id, created_at
FROM "order"
WHERE id = :'order_id';

-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [B] POS INVOICES ==='
SELECT
    id AS invoice_id, invoice_number, status,
    total/100.0        AS total_usd,
    amount_paid/100.0  AS paid_usd,
    balance_due/100.0  AS pending_usd,
    payment_method,
    fulfillment_id,
    created_at
FROM pos_invoice
WHERE order_id = :'order_id';

-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [C] ITEMS DEL INVOICE ==='
SELECT
    ii.invoice_id, ii.sku, ii.description,
    ii.quantity, ii.unit_price/100.0 AS unit_usd, ii.total/100.0 AS total_usd
FROM pos_invoice_item ii
JOIN pos_invoice i ON i.id = ii.invoice_id
WHERE i.order_id = :'order_id'
ORDER BY ii.id;

-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [D] INVOICE PAYMENTS (historial interno) ==='
SELECT
    ip.id, ip.invoice_id, ip.amount/100.0 AS usd, ip.payment_method, ip.notes, ip.paid_at
FROM invoice_payment ip
JOIN pos_invoice i ON i.id = ip.invoice_id
WHERE i.order_id = :'order_id';

-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [E] FINANCE LEDGER — CustomerPayment + Application ==='
SELECT
    cp.id  AS payment_id,
    cp.amount/100.0        AS usd,
    cp.method, cp.status, cp.source,
    pa.invoice_id,
    pa.amount_applied/100.0 AS applied_usd,
    pa.voided_at
FROM customer_payment cp
JOIN payment_application pa ON pa.payment_id = cp.id
JOIN pos_invoice i           ON i.id = pa.invoice_id
WHERE i.order_id = :'order_id';

-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [F] FULFILLMENT NATIVO MEDUSA ==='
SELECT
    id AS fulfillment_id, location_id, provider_id,
    packed_at, shipped_at, delivered_at, canceled_at, created_at
FROM fulfillment
WHERE order_id = :'order_id'
  AND deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [G] FULFILLMENT ITEMS NATIVOS ==='
SELECT
    fi.id, fi.fulfillment_id, fi.title, fi.sku, fi.quantity
FROM fulfillment_item fi
JOIN fulfillment f ON f.id = fi.fulfillment_id
WHERE f.order_id = :'order_id'
  AND f.deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────
\echo ''
\echo '=== [H] PAYMENT COLLECTION NATIVA ==='
SELECT
    pc.id AS payment_collection_id, pc.status AS pc_status,
    p.id  AS payment_id, p.amount/100.0 AS amount_usd,
    p.provider_id, p.authorized_at, p.captured_at
FROM payment_collection pc
LEFT JOIN payment p ON p.payment_collection_id = pc.id AND p.deleted_at IS NULL
WHERE pc.order_id = :'order_id'
  AND pc.deleted_at IS NULL;

\echo ''
\echo '=== FIN VERIFICACION ORDER #' :ORDER_DISPLAY_ID ' (id: ' :'order_id' ') ==='
