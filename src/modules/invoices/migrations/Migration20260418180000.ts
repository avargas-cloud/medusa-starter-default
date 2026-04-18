import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260418180000
 *
 * Part 2 of the payment_method / card_brand split (see also finance module
 * migration with the same timestamp).
 *
 * Naming decision:
 *   - 'credit_card'  → credit card transaction (new canonical value)
 *   - 'debit_card'   → debit card transaction  (already in DB constraint)
 *   - 'credit'       → store credit / credit memo (legacy meaning preserved)
 *   - 'card'         → legacy generic — new writes should use credit_card/debit_card
 *
 * Schema changes for `pos_invoice`:
 *   1. Add `card_brand` TEXT NULL column — stores the card network when the
 *      method is a card (visa, mastercard, amex, discover, capital_one). Null for
 *      non-card methods AND for debit-only transactions where the brand is not
 *      intentionally recorded.
 *   2. Expand the `payment_method` CHECK constraint to accept 'credit_card'.
 *      Other historical values (visa, mastercard, amex, discover, capital_one,
 *      debit_card) are preserved for backward compatibility; the backfill
 *      script later normalizes them into {payment_method: credit_card|debit_card,
 *      card_brand: <brand>|null}.
 *
 * No data changes — backfill is handled by a dedicated fix script.
 */
export class Migration20260418180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE pos_invoice
      ADD COLUMN IF NOT EXISTS card_brand TEXT NULL;
    `);

    this.addSql(`
      ALTER TABLE pos_invoice
      DROP CONSTRAINT IF EXISTS pos_invoice_payment_method_check;
    `);

    this.addSql(`
      ALTER TABLE pos_invoice
      ADD CONSTRAINT pos_invoice_payment_method_check
      CHECK (payment_method = ANY (ARRAY[
        'cash'::text,
        'check'::text,
        'card'::text,
        'ach'::text,
        'credit'::text,
        'mixed'::text,
        'visa'::text,
        'mastercard'::text,
        'discover'::text,
        'amex'::text,
        'capital_one'::text,
        'debit_card'::text,
        'checking_account'::text,
        'money_order'::text,
        'paypal'::text,
        'zelle'::text,
        'e_check'::text,
        'transfer'::text,
        'wire_transfer'::text,
        'credit_memo'::text,
        'credit_card'::text
      ]));
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS idx_pos_invoice_card_brand
      ON pos_invoice (card_brand)
      WHERE card_brand IS NOT NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS idx_pos_invoice_card_brand;`);

    this.addSql(`
      ALTER TABLE pos_invoice
      DROP CONSTRAINT IF EXISTS pos_invoice_payment_method_check;
    `);

    this.addSql(`
      ALTER TABLE pos_invoice
      ADD CONSTRAINT pos_invoice_payment_method_check
      CHECK (payment_method = ANY (ARRAY[
        'cash'::text,
        'check'::text,
        'card'::text,
        'ach'::text,
        'credit'::text,
        'mixed'::text,
        'visa'::text,
        'mastercard'::text,
        'discover'::text,
        'amex'::text,
        'capital_one'::text,
        'debit_card'::text,
        'checking_account'::text,
        'money_order'::text,
        'paypal'::text,
        'zelle'::text,
        'e_check'::text,
        'transfer'::text,
        'wire_transfer'::text,
        'credit_memo'::text
      ]));
    `);

    this.addSql(`ALTER TABLE pos_invoice DROP COLUMN IF EXISTS card_brand;`);
  }
}
