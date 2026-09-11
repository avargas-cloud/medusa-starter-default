import type { PoolClient } from "pg";

/**
 * e2e-gl-purchases-fixtures.ts — helpers de fixture para
 * `e2e-gl-purchases-sandbox.ts`. Separado del test para que el archivo
 * principal quede legible como una secuencia de pasos + asserts (el repo
 * limita archivos a 300 líneas, CLAUDE.md §G).
 */

export type FixtureRefs = {
  vendor_id: string;
  stock_location_id: string;
  product_variant_id: string;
  inventory_item_id: string;
  bank_list_id?: string;
};

export async function realRef(client: PoolClient): Promise<FixtureRefs> {
  const po = await client.query<{ vendor_id: string; stock_location_id: string }>(
    `SELECT vendor_id, stock_location_id FROM purchase_order LIMIT 1`
  );
  const line = await client.query<{ product_variant_id: string; inventory_item_id: string }>(
    `SELECT product_variant_id, inventory_item_id FROM purchase_order_line LIMIT 1`
  );
  const bank = await client.query<{ qb_list_id: string }>(
    `SELECT qb_list_id FROM qb_account WHERE account_type = 'Bank' AND is_active = true LIMIT 1`
  );
  return {
    vendor_id: po.rows[0]!.vendor_id,
    stock_location_id: po.rows[0]!.stock_location_id,
    product_variant_id: line.rows[0]!.product_variant_id,
    inventory_item_id: line.rows[0]!.inventory_item_id,
    bank_list_id: bank.rows[0]?.qb_list_id,
  };
}

export type Fixture = {
  poId: string;
  polId: string;
  receiptId: string;
  rlId: string;
  billId: string;
  vblId: string;
  bank_list_id?: string;
  vendor_id: string;
  product_variant_id: string;
};

export async function buildFixture(client: PoolClient, fxPrefix: string): Promise<Fixture> {
  const ref = await realRef(client);
  const poId = `${fxPrefix}_po`;
  const polId = `${fxPrefix}_pol`;
  const receiptId = `${fxPrefix}_por`;
  const rlId = `${fxPrefix}_rl`;
  const billId = `${fxPrefix}_vb`;
  const vblId = `${fxPrefix}_vbl`;

  await client.query(
    `INSERT INTO purchase_order (id, vendor_id, stock_location_id, status, number, created_by_user_id)
     VALUES ($1, $2, $3, 'partially_received', $4, 'e2e')`,
    [poId, ref.vendor_id, ref.stock_location_id, `E2E-${fxPrefix}`]
  );
  // costo PO = $10.00/u — el bill lo va a facturar a $12.00/u (variación de precio).
  await client.query(
    `INSERT INTO purchase_order_line
       (id, purchase_order_id, product_variant_id, inventory_item_id,
        sku_snapshot, description_snapshot, qty_ordered, qty_received, unit_cost_cents, total_cents)
     VALUES ($1, $2, $3, $4, 'E2E-SKU', 'E2E fixture line', 10, 10, 1000, 10000)`,
    [polId, poId, ref.product_variant_id, ref.inventory_item_id]
  );
  await client.query(
    `INSERT INTO purchase_order_receipt
       (id, purchase_order_id, number, seq, status, received_at, received_by_user_id, stock_location_id)
     VALUES ($1, $2, $3, 1, 'applied', NOW(), 'e2e', $4)`,
    [receiptId, poId, `RCP-${fxPrefix}`, ref.stock_location_id]
  );
  await client.query(
    `INSERT INTO purchase_order_receipt_line
       (id, purchase_order_receipt_id, purchase_order_line_id, purchase_order_id,
        product_variant_id, inventory_item_id, sku_snapshot, description_snapshot,
        qty_received_now, stock_applied)
     VALUES ($1, $2, $3, $4, $5, $6, 'E2E-SKU', 'E2E fixture line', 10, true)`,
    [rlId, receiptId, polId, poId, ref.product_variant_id, ref.inventory_item_id]
  );
  await client.query(
    `INSERT INTO vendor_bill
       (id, purchase_order_id, purchase_order_receipt_id, vendor_id, bill_type, status,
        number, confirmed_at, active_revision_id)
     VALUES ($1, $2, $3, $4, 'regular', 'confirmed', $5, NOW(), 'e2e_rev_1')`,
    [billId, poId, receiptId, ref.vendor_id, `VB-${fxPrefix}`]
  );
  await client.query(
    `INSERT INTO vendor_bill_line
       (id, vendor_bill_id, receipt_line_id, purchase_order_line_id, line_type,
        product_variant_id, sku, description, qty, unit_cost_cents, landed_total_cents, line_kind)
     VALUES ($1, $2, $3, $4, 'product', $5, 'E2E-SKU', 'E2E fixture line', 10, 1200, 12000, 'po_item')`,
    [vblId, billId, rlId, polId, ref.product_variant_id]
  );
  // D6: el receipt se ata al bill DESPUÉS de crear el bill (el bill lo necesita
  // para existir primero) — sin esto `loadBoundReceipts` no encuentra nada y
  // el offset queda en 0.
  await client.query(`UPDATE purchase_order_receipt SET vendor_bill_id = $1 WHERE id = $2`, [billId, receiptId]);

  return {
    poId,
    polId,
    receiptId,
    rlId,
    billId,
    vblId,
    bank_list_id: ref.bank_list_id,
    vendor_id: ref.vendor_id,
    product_variant_id: ref.product_variant_id,
  };
}

/**
 * `bank_journal_entry`/`bank_journal_line` son INMUTABLES (trigger
 * `bank_journal_immutable` — medido: un DELETE directo revienta). Nunca se
 * borran: el test reversa TODO antes de llamar acá, así que lo que queda es
 * post+reversa = efecto neto CERO en el journal, igual que cualquier
 * documento real cancelado — auditoría intacta, sin pisar el diseño
 * append-only. Esta función sólo borra las filas de DOMINIO del fixture,
 * incluidas `vendor_credit*`/`vendor_bill_payment*` (Phase 7: dejarlas vivas
 * acumula `e2egl_*` en el sandbox cada corrida — F2 sus tablas, pero son
 * filas nuestras, las borramos nosotros).
 */
export async function cleanup(
  client: PoolClient,
  fx: Fixture,
  creditId: string | null,
  paymentId: string | null
): Promise<void> {
  if (paymentId) {
    await client.query(`DELETE FROM vendor_bill_payment_allocation WHERE payment_id = $1`, [paymentId]);
    await client.query(`DELETE FROM vendor_bill_payment WHERE id = $1`, [paymentId]);
  }
  if (creditId) {
    await client.query(`DELETE FROM vendor_credit_application WHERE credit_id = $1`, [creditId]);
    await client.query(`DELETE FROM vendor_credit_line WHERE credit_id = $1`, [creditId]);
    await client.query(`DELETE FROM vendor_credit WHERE id = $1`, [creditId]);
  }
  await client.query(`DELETE FROM vendor_bill_line WHERE vendor_bill_id = $1`, [fx.billId]);
  await client.query(`DELETE FROM vendor_bill WHERE id = $1`, [fx.billId]);
  await client.query(`DELETE FROM purchase_order_receipt_line WHERE id = $1`, [fx.rlId]);
  await client.query(`DELETE FROM purchase_order_receipt WHERE id = $1`, [fx.receiptId]);
  await client.query(`DELETE FROM purchase_order_line WHERE id = $1`, [fx.polId]);
  await client.query(`DELETE FROM purchase_order WHERE id = $1`, [fx.poId]);
}
