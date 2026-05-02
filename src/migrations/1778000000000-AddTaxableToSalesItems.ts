import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Phase 1 — per-item tax exemption.
 *
 * Adds first-class `taxable BOOLEAN NOT NULL DEFAULT TRUE` to all sales-side
 * item tables and BEFORE-INSERT triggers that auto-copy the flag from the
 * upstream source (product.taxable for orders/invoices/credit_memos).
 *
 * Default TRUE preserves existing behavior; only products explicitly flagged
 * (e.g. INSTALL) will produce non-taxable line items. Callers that pass
 * taxable=false explicitly are respected — the triggers only fill in the
 * default case (NEW.taxable IS NULL OR NEW.taxable = TRUE).
 *
 * Scope (sales side only):
 *   - product                → master flag set per product in catalog
 *   - order_line_item        → estimates + orders share this table in Medusa v2
 *   - pos_invoice_item       → snapshot at invoice creation (drives reprint + QB sync)
 *   - pos_credit_memo_item   → snapshot at refund/return creation
 */
export class AddTaxableToSalesItems1778000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Columns (idempotent for re-runs)
    await queryRunner.query(
      `ALTER TABLE product ADD COLUMN IF NOT EXISTS taxable BOOLEAN NOT NULL DEFAULT TRUE`
    );
    await queryRunner.query(
      `ALTER TABLE order_line_item ADD COLUMN IF NOT EXISTS taxable BOOLEAN NOT NULL DEFAULT TRUE`
    );
    await queryRunner.query(
      `ALTER TABLE pos_invoice_item ADD COLUMN IF NOT EXISTS taxable BOOLEAN NOT NULL DEFAULT TRUE`
    );
    await queryRunner.query(
      `ALTER TABLE pos_credit_memo_item ADD COLUMN IF NOT EXISTS taxable BOOLEAN NOT NULL DEFAULT TRUE`
    );

    // 2. Auto-resolver trigger: when a new order_line_item is inserted with
    //    the default taxable=TRUE, fall through to the parent product's flag.
    //    Explicit FALSE from caller is preserved (only overrides defaults).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_order_line_item_taxable_from_product()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.product_id IS NOT NULL AND (NEW.taxable IS NULL OR NEW.taxable = TRUE) THEN
          SELECT COALESCE(taxable, TRUE) INTO NEW.taxable
            FROM product WHERE id = NEW.product_id;
          IF NEW.taxable IS NULL THEN
            NEW.taxable := TRUE;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_line_item_taxable_default ON order_line_item`
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_order_line_item_taxable_default
      BEFORE INSERT ON order_line_item
      FOR EACH ROW EXECUTE FUNCTION set_order_line_item_taxable_from_product()
    `);

    // 3. Auto-resolver for pos_invoice_item — copies from product (via variant_id).
    //    Invoices snapshot order line items; the upstream order_line_item.taxable
    //    is already correct, but resolving via variant→product is identical for
    //    practical purposes (taxable rarely changes mid-order) and avoids brittle
    //    sku-based JOINs across versions/voids.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_pos_invoice_item_taxable_from_product()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.variant_id IS NOT NULL AND (NEW.taxable IS NULL OR NEW.taxable = TRUE) THEN
          SELECT COALESCE(p.taxable, TRUE) INTO NEW.taxable
            FROM product_variant pv
            JOIN product p ON p.id = pv.product_id
           WHERE pv.id = NEW.variant_id;
          IF NEW.taxable IS NULL THEN
            NEW.taxable := TRUE;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_pos_invoice_item_taxable_default ON pos_invoice_item`
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_pos_invoice_item_taxable_default
      BEFORE INSERT ON pos_invoice_item
      FOR EACH ROW EXECUTE FUNCTION set_pos_invoice_item_taxable_from_product()
    `);

    // 4. Auto-resolver for pos_credit_memo_item — same lookup pattern.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION set_pos_credit_memo_item_taxable_from_product()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.variant_id IS NOT NULL AND (NEW.taxable IS NULL OR NEW.taxable = TRUE) THEN
          SELECT COALESCE(p.taxable, TRUE) INTO NEW.taxable
            FROM product_variant pv
            JOIN product p ON p.id = pv.product_id
           WHERE pv.id = NEW.variant_id;
          IF NEW.taxable IS NULL THEN
            NEW.taxable := TRUE;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_pos_credit_memo_item_taxable_default ON pos_credit_memo_item`
    );
    await queryRunner.query(`
      CREATE TRIGGER trg_pos_credit_memo_item_taxable_default
      BEFORE INSERT ON pos_credit_memo_item
      FOR EACH ROW EXECUTE FUNCTION set_pos_credit_memo_item_taxable_from_product()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_pos_credit_memo_item_taxable_default ON pos_credit_memo_item`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS set_pos_credit_memo_item_taxable_from_product()`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_pos_invoice_item_taxable_default ON pos_invoice_item`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS set_pos_invoice_item_taxable_from_product()`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_order_line_item_taxable_default ON order_line_item`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS set_order_line_item_taxable_from_product()`
    );
    await queryRunner.query(
      `ALTER TABLE pos_credit_memo_item DROP COLUMN IF EXISTS taxable`
    );
    await queryRunner.query(
      `ALTER TABLE pos_invoice_item DROP COLUMN IF EXISTS taxable`
    );
    await queryRunner.query(
      `ALTER TABLE order_line_item DROP COLUMN IF EXISTS taxable`
    );
    await queryRunner.query(
      `ALTER TABLE product DROP COLUMN IF EXISTS taxable`
    );
  }
}
