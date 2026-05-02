-- =====================================================================
-- Surgical SKU swap on Invoice 20225 / Order 1590 (display_id)
--
-- Wrong product was billed: EAP-SM5-8S (8-feet Slim Aluminum Channel)
-- Must be replaced by:     SUP-AP-IP-SM5-8S
--
-- Same quantity (24), same unit price ($23.99), same totals.
-- QuickBooks edit handled manually by user — this script does NOT touch QB.
--
-- Affected rows (one each):
--   order_line_item    ordli_01KQCWBW9DB3G0NW3PSZ5E3C9Z
--   pos_invoice_item   01KQG5MNYNXR2381CQM2GRJS87  (invoice 20225)
--   fulfillment_item   fulit_01KQG5MMJPC35KWZR3MERKFA5Q
--   inventory_level    iitem_01KFS1HCV4PFQXSDHJ1M36HZ84  (EAP-SM5-8S, +24)
--   inventory_level    iitem_01KK5EWBRTWG2NGW2F41ZSB7CK  (SUP-AP-IP-SM5-8S, -24)
--   order_change + order_change_action  (audit entry, version 5)
-- =====================================================================

\set ON_ERROR_STOP on
\set ECHO queries

BEGIN;

-- ---------------------------------------------------------------------
-- Pre-condition guards: refuse to run if state is not what we expect
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_sku        TEXT;
  v_qty        NUMERIC;
  v_pii_sku    TEXT;
  v_pii_qty    NUMERIC;
  v_ful_sku    TEXT;
  v_ful_qty    NUMERIC;
  v_src_stock  NUMERIC;
  v_dst_stock  NUMERIC;
BEGIN
  -- order_line_item must exist with expected SKU + qty
  SELECT li.variant_sku, oi.quantity
    INTO v_sku, v_qty
    FROM order_line_item li
    JOIN order_item oi ON oi.item_id = li.id
   WHERE li.id = 'ordli_01KQCWBW9DB3G0NW3PSZ5E3C9Z'
   ORDER BY oi.version DESC
   LIMIT 1;
  IF v_sku IS NULL THEN
    RAISE EXCEPTION 'GUARD: order_line_item ordli_01KQCWBW9DB3G0NW3PSZ5E3C9Z not found';
  END IF;
  IF v_sku <> 'EAP-SM5-8S' OR v_qty <> 24 THEN
    RAISE EXCEPTION 'GUARD: order_line_item expected (EAP-SM5-8S,24), got (%,%)', v_sku, v_qty;
  END IF;

  -- pos_invoice_item must exist
  SELECT sku, quantity INTO v_pii_sku, v_pii_qty
    FROM pos_invoice_item WHERE id = '01KQG5MNYNXR2381CQM2GRJS87';
  IF v_pii_sku IS NULL THEN
    RAISE EXCEPTION 'GUARD: pos_invoice_item 01KQG5MNYNXR2381CQM2GRJS87 not found';
  END IF;
  IF v_pii_sku <> 'EAP-SM5-8S' OR v_pii_qty <> 24 THEN
    RAISE EXCEPTION 'GUARD: pos_invoice_item expected (EAP-SM5-8S,24), got (%,%)', v_pii_sku, v_pii_qty;
  END IF;

  -- fulfillment_item must exist
  SELECT sku, quantity INTO v_ful_sku, v_ful_qty
    FROM fulfillment_item WHERE id = 'fulit_01KQG5MMJPC35KWZR3MERKFA5Q';
  IF v_ful_sku IS NULL THEN
    RAISE EXCEPTION 'GUARD: fulfillment_item fulit_01KQG5MMJPC35KWZR3MERKFA5Q not found';
  END IF;
  IF v_ful_sku <> 'EAP-SM5-8S' OR v_ful_qty <> 24 THEN
    RAISE EXCEPTION 'GUARD: fulfillment_item expected (EAP-SM5-8S,24), got (%,%)', v_ful_sku, v_ful_qty;
  END IF;

  -- Source inventory_level must exist (so we can add 24 back)
  SELECT stocked_quantity INTO v_src_stock
    FROM inventory_level
   WHERE inventory_item_id = 'iitem_01KFS1HCV4PFQXSDHJ1M36HZ84'
     AND location_id       = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR';
  IF v_src_stock IS NULL THEN
    RAISE EXCEPTION 'GUARD: EAP-SM5-8S inventory_level at Miami sloc not found';
  END IF;

  -- Destination inventory_level must exist with enough stock
  SELECT stocked_quantity INTO v_dst_stock
    FROM inventory_level
   WHERE inventory_item_id = 'iitem_01KK5EWBRTWG2NGW2F41ZSB7CK'
     AND location_id       = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR';
  IF v_dst_stock IS NULL THEN
    RAISE EXCEPTION 'GUARD: SUP-AP-IP-SM5-8S inventory_level at Miami sloc not found';
  END IF;
  IF v_dst_stock < 24 THEN
    RAISE EXCEPTION 'GUARD: SUP-AP-IP-SM5-8S stock % is below 24 — would go negative', v_dst_stock;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 1) order_line_item — swap product/variant identity + display fields
-- ---------------------------------------------------------------------
UPDATE order_line_item SET
  variant_id          = 'variant_01KK53MVFB8VYMSB6RY9GY51NJ',
  product_id          = 'prod_01KK53MVFBTGKCFKBV134QAG5C',
  product_title       = 'SUP-AP-IP-SM5-8S',
  product_handle      = 'sup-ap-ip-sm5-8s',
  product_description = NULL,
  variant_sku         = 'SUP-AP-IP-SM5-8S',
  title               = 'SUP-AP-IP-SM5-8S - Default',
  thumbnail           = 'https://bucket-production-2e09.up.railway.app/medusa-media/products/SM5-1776364815576.jpg',
  updated_at          = NOW()
WHERE id = 'ordli_01KQCWBW9DB3G0NW3PSZ5E3C9Z';

-- ---------------------------------------------------------------------
-- 2) pos_invoice_item — invoice snapshot (frozen but must reflect swap)
-- ---------------------------------------------------------------------
UPDATE pos_invoice_item SET
  variant_id  = 'variant_01KK53MVFB8VYMSB6RY9GY51NJ',
  sku         = 'SUP-AP-IP-SM5-8S',
  description = '',
  updated_at  = NOW()
WHERE id = '01KQG5MNYNXR2381CQM2GRJS87';

-- ---------------------------------------------------------------------
-- 3) fulfillment_item — physical-shipment record
-- ---------------------------------------------------------------------
UPDATE fulfillment_item SET
  inventory_item_id = 'iitem_01KK5EWBRTWG2NGW2F41ZSB7CK',
  sku               = 'SUP-AP-IP-SM5-8S',
  title             = 'SUP-AP-IP-SM5-8S - Default',
  updated_at        = NOW()
WHERE id = 'fulit_01KQG5MMJPC35KWZR3MERKFA5Q';

-- ---------------------------------------------------------------------
-- 4) inventory_level — restore +24 to EAP-SM5-8S (was wrongly deducted)
-- ---------------------------------------------------------------------
UPDATE inventory_level SET
  stocked_quantity     = stocked_quantity + 24,
  raw_stocked_quantity = jsonb_build_object('value', (stocked_quantity + 24)::text, 'precision', 20),
  updated_at           = NOW()
WHERE inventory_item_id = 'iitem_01KFS1HCV4PFQXSDHJ1M36HZ84'
  AND location_id       = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR';

-- ---------------------------------------------------------------------
-- 5) inventory_level — deduct -24 from SUP-AP-IP-SM5-8S (was actually shipped)
-- ---------------------------------------------------------------------
UPDATE inventory_level SET
  stocked_quantity     = stocked_quantity - 24,
  raw_stocked_quantity = jsonb_build_object('value', (stocked_quantity - 24)::text, 'precision', 20),
  updated_at           = NOW()
WHERE inventory_item_id = 'iitem_01KK5EWBRTWG2NGW2F41ZSB7CK'
  AND location_id       = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR';

-- ---------------------------------------------------------------------
-- 6) Audit trail: order_change + order_change_action  (visible in Activity log)
-- ---------------------------------------------------------------------
WITH new_change AS (
  INSERT INTO order_change (
    id, order_id, version, change_type, status, description,
    requested_at, confirmed_at, created_at, updated_at
  )
  VALUES (
    'ordch_swap_inv20225_' || substr(replace(gen_random_uuid()::text,'-',''),1,20),
    'order_01KQCWBVVQ6F8AY7D7TN6Z3HB6',
    (SELECT COALESCE(MAX(version), 0) FROM order_item WHERE order_id = 'order_01KQCWBVVQ6F8AY7D7TN6Z3HB6'),
    'update_order',
    'confirmed',
    'Manual SKU swap (invoice 20225): line item EAP-SM5-8S -> SUP-AP-IP-SM5-8S, qty=24, price unchanged ($23.99). Inventory adjusted: +24 EAP-SM5-8S, -24 SUP-AP-IP-SM5-8S. QuickBooks updated separately.',
    NOW(), NOW(), NOW(), NOW()
  )
  RETURNING id
)
INSERT INTO order_change_action (
  id, order_id, version, ordering, order_change_id, reference, reference_id,
  action, details, applied, created_at, updated_at
)
SELECT
  'ordact_swap_inv20225_' || substr(replace(gen_random_uuid()::text,'-',''),1,20),
  'order_01KQCWBVVQ6F8AY7D7TN6Z3HB6',
  (SELECT COALESCE(MAX(version), 0) FROM order_item WHERE order_id = 'order_01KQCWBVVQ6F8AY7D7TN6Z3HB6'),
  COALESCE((SELECT MAX(ordering) FROM order_change_action WHERE order_id = 'order_01KQCWBVVQ6F8AY7D7TN6Z3HB6'), 0) + 1,
  nc.id,
  'order_line_item',
  'ordli_01KQCWBW9DB3G0NW3PSZ5E3C9Z',
  'ITEM_UPDATE',
  jsonb_build_object(
    'reason',           'manual_sku_swap',
    'invoice_number',   '20225',
    'line_item_id',     'ordli_01KQCWBW9DB3G0NW3PSZ5E3C9Z',
    'pos_invoice_item', '01KQG5MNYNXR2381CQM2GRJS87',
    'fulfillment_item', 'fulit_01KQG5MMJPC35KWZR3MERKFA5Q',
    'from', jsonb_build_object(
      'sku',          'EAP-SM5-8S',
      'variant_id',   'variant_8-feet-slim-aluminum-channel_default',
      'product_id',   'product_01KGAX7RCWKGMW8HD34Q1SB1PB',
      'inventory_item_id', 'iitem_01KFS1HCV4PFQXSDHJ1M36HZ84'
    ),
    'to', jsonb_build_object(
      'sku',          'SUP-AP-IP-SM5-8S',
      'variant_id',   'variant_01KK53MVFB8VYMSB6RY9GY51NJ',
      'product_id',   'prod_01KK53MVFBTGKCFKBV134QAG5C',
      'inventory_item_id', 'iitem_01KK5EWBRTWG2NGW2F41ZSB7CK'
    ),
    'quantity',          24,
    'price_unchanged',   true,
    'inventory_adjusted', true
  ),
  true, NOW(), NOW()
FROM new_change nc;

-- ---------------------------------------------------------------------
-- Post-condition checks
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_li_sku    TEXT;
  v_pii_sku   TEXT;
  v_ful_sku   TEXT;
  v_src_stock NUMERIC;
  v_dst_stock NUMERIC;
  v_audit_n   INT;
BEGIN
  SELECT variant_sku INTO v_li_sku
    FROM order_line_item WHERE id = 'ordli_01KQCWBW9DB3G0NW3PSZ5E3C9Z';
  SELECT sku INTO v_pii_sku
    FROM pos_invoice_item WHERE id = '01KQG5MNYNXR2381CQM2GRJS87';
  SELECT sku INTO v_ful_sku
    FROM fulfillment_item WHERE id = 'fulit_01KQG5MMJPC35KWZR3MERKFA5Q';
  SELECT stocked_quantity INTO v_src_stock
    FROM inventory_level
   WHERE inventory_item_id = 'iitem_01KFS1HCV4PFQXSDHJ1M36HZ84'
     AND location_id       = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR';
  SELECT stocked_quantity INTO v_dst_stock
    FROM inventory_level
   WHERE inventory_item_id = 'iitem_01KK5EWBRTWG2NGW2F41ZSB7CK'
     AND location_id       = 'sloc_01KFS2AV3TAKR141KC2D6JCGTR';
  SELECT count(*) INTO v_audit_n
    FROM order_change WHERE order_id = 'order_01KQCWBVVQ6F8AY7D7TN6Z3HB6'
                        AND description LIKE 'Manual SKU swap (invoice 20225)%';

  IF v_li_sku  IS DISTINCT FROM 'SUP-AP-IP-SM5-8S' THEN RAISE EXCEPTION 'POST: order_line_item sku=%', v_li_sku; END IF;
  IF v_pii_sku IS DISTINCT FROM 'SUP-AP-IP-SM5-8S' THEN RAISE EXCEPTION 'POST: pos_invoice_item sku=%', v_pii_sku; END IF;
  IF v_ful_sku IS DISTINCT FROM 'SUP-AP-IP-SM5-8S' THEN RAISE EXCEPTION 'POST: fulfillment_item sku=%', v_ful_sku; END IF;
  IF v_src_stock IS NULL THEN RAISE EXCEPTION 'POST: src stock NULL'; END IF;
  IF v_dst_stock IS NULL OR v_dst_stock < 0 THEN RAISE EXCEPTION 'POST: dst stock invalid (%)', v_dst_stock; END IF;
  IF v_audit_n < 1 THEN RAISE EXCEPTION 'POST: audit row missing (count=%)', v_audit_n; END IF;

  RAISE NOTICE 'OK: line=%, invoice_item=%, fulfillment=%, src_stock=%, dst_stock=%, audit_rows=%',
    v_li_sku, v_pii_sku, v_ful_sku, v_src_stock, v_dst_stock, v_audit_n;
END $$;

COMMIT;

-- =====================================================================
-- Verification report
-- =====================================================================
\echo
\echo '=== AFTER SWAP ==='
SELECT 'order_line_item' AS surface, variant_sku, product_id, title
  FROM order_line_item WHERE id = 'ordli_01KQCWBW9DB3G0NW3PSZ5E3C9Z';

SELECT 'pos_invoice_item' AS surface, sku, variant_id, quantity, unit_price, total
  FROM pos_invoice_item WHERE id = '01KQG5MNYNXR2381CQM2GRJS87';

SELECT 'fulfillment_item' AS surface, sku, inventory_item_id, quantity
  FROM fulfillment_item WHERE id = 'fulit_01KQG5MMJPC35KWZR3MERKFA5Q';

SELECT 'inventory' AS surface, ii.sku, il.location_id, il.stocked_quantity, il.reserved_quantity
  FROM inventory_level il
  JOIN inventory_item  ii ON ii.id = il.inventory_item_id
 WHERE il.inventory_item_id IN ('iitem_01KFS1HCV4PFQXSDHJ1M36HZ84', 'iitem_01KK5EWBRTWG2NGW2F41ZSB7CK')
 ORDER BY ii.sku, il.location_id;

SELECT 'order_change' AS surface, change_type, status, description, created_at
  FROM order_change
 WHERE order_id = 'order_01KQCWBVVQ6F8AY7D7TN6Z3HB6'
 ORDER BY created_at DESC LIMIT 1;
