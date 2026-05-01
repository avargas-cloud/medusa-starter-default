-- Replicate orden 1350 production state in sandbox so we can test the
-- partial-invoice-fix script. Mirrors the data we observed on prod.

-- 1. pos_invoice 20226 / id 01KQG8G8KESSWKWY1V2WKQ31BT
INSERT INTO pos_invoice (
  id, invoice_number, order_id, fulfillment_id, customer_id,
  status, subtotal, tax, total, amount_paid, balance_due, payment_method,
  raw_subtotal, raw_tax, raw_total, raw_amount_paid, raw_balance_due,
  shipping, discount, raw_discount,
  untaxed_total, raw_untaxed_total,
  refunded_amount, raw_refunded_amount,
  refunded_shipping, raw_refunded_shipping,
  card_brand, issued_at, paid_at,
  created_by, metadata, created_at, updated_at
) VALUES (
  '01KQG8G8KESSWKWY1V2WKQ31BT', '20226', 'order_01KP64PS82JB844N64TFJEWA0X',
  'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', 'cus_01KG0R9EF8M8VW51K83CHC9RK7',
  'paid', 641907, 0, 641907, 641907, 0, 'visa',
  '{"value":"6419.07","precision":20}'::jsonb,
  '{"value":"0","precision":20}'::jsonb,
  '{"value":"6419.07","precision":20}'::jsonb,
  '{"value":"6419.07","precision":20}'::jsonb,
  '{"value":"0","precision":20}'::jsonb,
  0, 269893,
  '{"value":"2698.93","precision":20}'::jsonb,
  641907,
  '{"value":"6419.07","precision":20}'::jsonb,
  0,
  '{"value":"0","precision":20}'::jsonb,
  0,
  '{"value":"0","precision":20}'::jsonb,
  NULL, '2026-04-30 22:35:11+00', '2026-04-30 22:35:11+00',
  'a.arenas@ecopowertech.com',
  '{"qb_ref_number":"19472","is_sales_receipt":false}'::jsonb,
  '2026-04-30 22:35:11+00', '2026-04-30 22:35:11+00'
) ON CONFLICT (id) DO NOTHING;

-- 2. pos_invoice_item rows (7 items at LIST prices)
INSERT INTO pos_invoice_item (
  id, invoice_id, variant_id, sku, description, quantity, unit_price, total,
  raw_unit_price, raw_total, refunded_quantity, created_at, updated_at
) VALUES
  ('piitm_test_1', '01KQG8G8KESSWKWY1V2WKQ31BT', 'variant_01KPE2XS845DK7M2HC8M3CPM80',
   'ET2-E11040-24GLD', 'Axle LED Pendant', 4, 23800, 95200,
   '{"value":"238","precision":20}'::jsonb, '{"value":"952","precision":20}'::jsonb,
   0, NOW(), NOW()),
  ('piitm_test_2', '01KQG8G8KESSWKWY1V2WKQ31BT', 'variant_01KPE2XS84KAWJM18JMJW8XY66',
   'ET2-E24188-148GLD', 'Planetary 8-Light LED Chandelier', 1, 67800, 67800,
   '{"value":"678","precision":20}'::jsonb, '{"value":"678","precision":20}'::jsonb,
   0, NOW(), NOW()),
  ('piitm_test_3', '01KQG8G8KESSWKWY1V2WKQ31BT', 'variant_01KPE2XS846QKX7SKVE3WE2BXH',
   'ET2-E24646-144GLD', 'Rhythm 9-Light LED Pendant', 1, 229800, 229800,
   '{"value":"2298","precision":20}'::jsonb, '{"value":"2298","precision":20}'::jsonb,
   0, NOW(), NOW()),
  ('piitm_test_4', '01KQG8G8KESSWKWY1V2WKQ31BT', 'variant_01KPE2XS846VHM767MSF9877ZB',
   'ET2-E24643-144GLD', 'Rhythm 3-Light LED Pendant', 2, 77800, 155600,
   '{"value":"778","precision":20}'::jsonb, '{"value":"1556","precision":20}'::jsonb,
   0, NOW(), NOW()),
  ('piitm_test_5', '01KQG8G8KESSWKWY1V2WKQ31BT', 'variant_01KPE2XSF8JWYP4NGJB7NKPY07',
   'MAX-88831BK', 'Woodwind 52" Solid Wood Blade Fan', 3, 46800, 140400,
   '{"value":"468","precision":20}'::jsonb, '{"value":"1404","precision":20}'::jsonb,
   0, NOW(), NOW()),
  ('piitm_test_6', '01KQG8G8KESSWKWY1V2WKQ31BT', 'variant_01KPE2XSF8KYJMPX686K95Q52Z',
   'MAX-88833BK', 'Woodwind 72" Solid Wood Blade Hugger Fan', 2, 63800, 127600,
   '{"value":"638","precision":20}'::jsonb, '{"value":"1276","precision":20}'::jsonb,
   0, NOW(), NOW()),
  ('piitm_test_7', '01KQG8G8KESSWKWY1V2WKQ31BT', 'variant_01KPE2XSF81E5WPAM07R23MR1B',
   'MAX-88723BK', 'Seaborne 52" Marine Grade Fan', 3, 31800, 95400,
   '{"value":"318","precision":20}'::jsonb, '{"value":"954","precision":20}'::jsonb,
   0, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- 3. customer_payment cpay_01KPEBMA281Z36PKBYDN7Y7RKY (already exists from prod dump)
-- 4. payment_application papp_01KQG8G8SH488EFEV3H1KNH6M8 (need to create)
INSERT INTO payment_application (
  id, payment_id, invoice_id, order_id, amount_applied, raw_amount_applied,
  applied_at, applied_by, invoice_number, created_at, updated_at
) VALUES (
  'papp_01KQG8G8SH488EFEV3H1KNH6M8', 'cpay_01KPEBMA281Z36PKBYDN7Y7RKY',
  '01KQG8G8KESSWKWY1V2WKQ31BT', 'order_01KP64PS82JB844N64TFJEWA0X',
  641907, '{"value":"6419.07","precision":20}'::jsonb,
  '2026-04-30 22:35:11+00', 'fix-script-test', '20226',
  '2026-04-30 22:35:11+00', '2026-04-30 22:35:11+00'
) ON CONFLICT (id) DO NOTHING;

-- Mark cpay as fully applied
UPDATE customer_payment
   SET status = 'applied', updated_at = NOW()
 WHERE id = 'cpay_01KPEBMA281Z36PKBYDN7Y7RKY';

-- 5. fulfillment_item rows (need to exist for the 3 SKUs to be removed)
-- Use the inventory_item_ids we already know. line_item_ids must come from
-- order_line_item that exists.
-- Note: fulfillment must exist too. Create if missing:
INSERT INTO fulfillment (
  id, location_id, packed_at, shipped_at, delivered_at,
  packed_at_metadata, shipped_at_metadata, provider_id,
  created_at, updated_at
) VALUES (
  'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', 'sloc_01KFS2AV3TAKR141KC2D6JCGTR',
  '2026-04-30 22:35:00+00', '2026-04-30 22:35:00+00', '2026-04-30 22:35:00+00',
  NULL, NULL, 'manual_manual',
  NOW(), NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO fulfillment_item (
  id, title, sku, barcode, quantity, raw_quantity, line_item_id,
  inventory_item_id, fulfillment_id, created_at, updated_at
) VALUES
  ('fitem_test_1', 'Axle LED', 'ET2-E11040-24GLD', '', 4,
   '{"value":"4","precision":20}'::jsonb,
   'ordli_01KPP5EYNC99P32JVK73V399DT', 'iitem_01KPP4XMX27GRQ6ES84WGHZJWP',
   'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', NOW(), NOW()),
  ('fitem_test_2', 'Planetary', 'ET2-E24188-148GLD', '', 1,
   '{"value":"1","precision":20}'::jsonb,
   'ordli_01KPP5EWH1QARWDJPD01K5D5JH', 'iitem_01KPGH7WXA0RVAJ7R3HWFG6DPM',
   'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', NOW(), NOW()),
  ('fitem_test_3', 'Rhythm 9', 'ET2-E24646-144GLD', '', 1,
   '{"value":"1","precision":20}'::jsonb,
   'ordli_01KPP5EWWPB9MVM0EXP7Z5NQ44', 'iitem_01KPGH7S3CA7BXEM4HVFVFKGN3',
   'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', NOW(), NOW()),
  ('fitem_test_4', 'Rhythm 3', 'ET2-E24643-144GLD', '', 2,
   '{"value":"2","precision":20}'::jsonb,
   'ordli_01KPP5EX806Y0PA3W30WZXWTC2', 'iitem_01KPGH7SNR0VC7J8N2T0EQ0BD2',
   'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', NOW(), NOW()),
  ('fitem_test_5', 'Woodwind 52', 'MAX-88831BK', '', 3,
   '{"value":"3","precision":20}'::jsonb,
   'ordli_01KPP5EXKBVPRW77YXW6KJGN86', 'iitem_01KPGH835KX88FBG9WJKP802JY',
   'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', NOW(), NOW()),
  ('fitem_test_6', 'Woodwind 72', 'MAX-88833BK', '', 2,
   '{"value":"2","precision":20}'::jsonb,
   'ordli_01KPP5KFCJNBTR8TQ0DH0DBPCB', 'iitem_01KPGH84ABS09F0VHJDXE5NRBS',
   'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', NOW(), NOW()),
  ('fitem_test_7', 'Seaborne 52', 'MAX-88723BK', '', 3,
   '{"value":"3","precision":20}'::jsonb,
   'ordli_01KPP5ETZ4MDASR6Y3FEMF72M9', 'iitem_01KPGH7ZXEBZVMCY0THNVPAXA3',
   'ful_01KQG8G7JW0GZ47V78MGFJ4GNF', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

-- 6. Update order_item for orden 1350 to mark fulfilled = quantity for the 7 items
UPDATE order_item SET
  fulfilled_quantity = quantity,
  raw_fulfilled_quantity = jsonb_build_object('value', quantity::text, 'precision', 20),
  delivered_quantity = quantity,
  raw_delivered_quantity = jsonb_build_object('value', quantity::text, 'precision', 20)
 WHERE order_id = 'order_01KP64PS82JB844N64TFJEWA0X'
   AND deleted_at IS NULL;

-- 7. Set inventory_level stocked_quantity = 0 for the 3 SKUs (they were sold)
-- (already 0 in sandbox, but ensure it's deterministic before the fix increments it)
UPDATE inventory_level
   SET stocked_quantity = 0,
       raw_stocked_quantity = '{"value":"0","precision":20}'::jsonb
 WHERE inventory_item_id IN
   ('iitem_01KPGH7S3CA7BXEM4HVFVFKGN3',  -- ET2-E24646-144GLD
    'iitem_01KPGH7SNR0VC7J8N2T0EQ0BD2',  -- ET2-E24643-144GLD
    'iitem_01KPGH7ZXEBZVMCY0THNVPAXA3'); -- MAX-88723BK
