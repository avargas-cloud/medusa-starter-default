import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260418180000
 *
 * Part 1 of the payment_method / card_brand split (see also invoices module
 * migration with the same timestamp).
 *
 * Naming decision:
 *   - 'credit_card'  → credit card transaction (new canonical value)
 *   - 'debit_card'   → debit card transaction  (new canonical value)
 *   - 'credit'       → store credit / credit memo (legacy meaning preserved)
 *   - 'card'         → legacy generic — new writes should use credit_card/debit_card
 *
 * Schema changes for `customer_payment`:
 *   1. Add `card_brand` TEXT NULL column — stores the card network when the
 *      method is a card (visa, mastercard, amex, discover, capital_one, etc.).
 *      Null for non-card methods (cash, check, zelle, ach, ...) OR for debit
 *      cards where we intentionally don't record the brand.
 *   2. Expand the `method` CHECK constraint to accept 'credit_card' and 'debit_card'
 *      in addition to the existing values.
 *
 * No data changes — backfill is handled by a dedicated fix script.
 */
export class Migration20260418180001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE customer_payment
      ADD COLUMN IF NOT EXISTS card_brand TEXT NULL;
    `);

    this.addSql(`
      ALTER TABLE customer_payment
      DROP CONSTRAINT IF EXISTS customer_payment_method_check;
    `);

    this.addSql(`
      ALTER TABLE customer_payment
      ADD CONSTRAINT customer_payment_method_check
      CHECK (method = ANY (ARRAY[
        'cash'::text,
        'check'::text,
        'card'::text,
        'ach'::text,
        'zelle'::text,
        'credit_memo'::text,
        'stripe'::text,
        'authorize_net'::text,
        'other'::text,
        'credit_card'::text,
        'debit_card'::text
      ]));
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_customer_payment_card_brand
      ON customer_payment (card_brand)
      WHERE card_brand IS NOT NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_customer_payment_card_brand;`);

    this.addSql(`
      ALTER TABLE customer_payment
      DROP CONSTRAINT IF EXISTS customer_payment_method_check;
    `);

    this.addSql(`
      ALTER TABLE customer_payment
      ADD CONSTRAINT customer_payment_method_check
      CHECK (method = ANY (ARRAY[
        'cash'::text,
        'check'::text,
        'card'::text,
        'ach'::text,
        'zelle'::text,
        'credit_memo'::text,
        'stripe'::text,
        'authorize_net'::text,
        'other'::text
      ]));
    `);

    this.addSql(
      `ALTER TABLE customer_payment DROP COLUMN IF EXISTS card_brand;`
    );
  }
}
