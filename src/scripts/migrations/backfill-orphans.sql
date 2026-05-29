-- backfill-orphans.sql
-- Links orphan customer_payments (belong to a real order, no payment_application)
-- by inserting an ORDER-ONLY payment_application with a frozen cost_snapshot.
-- Mirrors buildOrderCostSnapshot + handle-order-apply. Idempotent: re-running
-- skips payments that already have a non-voided application.
--
-- Run:  psql "<conn>" -v ON_ERROR_STOP=1 -f backfill-orphans.sql
-- Preview first with the SELECT at the bottom (commented).

BEGIN;

WITH orphans AS (
  SELECT
    cp.id            AS payment_id,
    cp.amount        AS amount,
    COALESCE(om.id, ol.id) AS order_id
  FROM customer_payment cp
  LEFT JOIN "order" om ON om.id = (cp.metadata->>'order_id')
  LEFT JOIN "order" ol ON ol.id = cp.locked_order_id
  WHERE cp.deleted_at IS NULL
    AND cp.type = 'payment'
    AND cp.status <> 'voided'
    AND COALESCE(cp.method, '') <> 'credit_memo'
    AND COALESCE(om.id, ol.id) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM payment_application pa
      WHERE pa.payment_id = cp.id AND pa.voided_at IS NULL
    )
),
snap AS (
  -- Build the cost_snapshot JSON per orphan order, mirroring buildOrderCostSnapshot.
  SELECT
    o.payment_id,
    o.amount,
    o.order_id,
    jsonb_build_object(
      'captured_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'lines', COALESCE(jsonb_agg(
        jsonb_build_object(
          'line_id', oli.id,
          'variant_id', oli.variant_id,
          'sku', COALESCE(NULLIF(oli.variant_sku,''), NULLIF(pv.sku,''), oli.id),
          'quantity', oi.quantity,
          'unit_cost_cents', ROUND(COALESCE(
            NULLIF(pv.metadata->>'avg_landed_cost_cents','')::numeric,
            NULLIF(pv.metadata->>'qb_avg_cost','')::numeric * 100,
            NULLIF(pv.metadata->>'qb_purchase_cost','')::numeric * 100
          )),
          'is_china', ((p.metadata->>'is_sourced_via_agent') = 'true')
        )
      ) FILTER (WHERE oli.id IS NOT NULL), '[]'::jsonb)
    ) AS cost_snapshot
  FROM orphans o
  LEFT JOIN order_item oi ON oi.order_id = o.order_id
  LEFT JOIN order_line_item oli ON oli.id = oi.item_id AND oli.deleted_at IS NULL
  LEFT JOIN product_variant pv ON pv.id = oli.variant_id
  LEFT JOIN product p ON p.id = pv.product_id
  GROUP BY o.payment_id, o.amount, o.order_id
)
INSERT INTO payment_application
  (id, payment_id, invoice_id, invoice_number, order_id, amount_applied,
   applied_at, applied_by, raw_amount_applied, cost_snapshot,
   created_at, updated_at)
SELECT
  'papp_bf_' || substr(md5(random()::text || s.payment_id), 1, 24),
  s.payment_id,
  NULL,
  NULL,
  s.order_id,
  s.amount,
  now(),
  'system:backfill-orphan',
  jsonb_build_object('value', s.amount::text, 'precision', 20),
  s.cost_snapshot,
  now(),
  now()
FROM snap s;

COMMIT;
