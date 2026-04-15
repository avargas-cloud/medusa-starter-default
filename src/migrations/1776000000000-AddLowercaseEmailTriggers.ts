import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AddLowercaseEmailTriggers
 *
 * Enforces lowercase emails at the database level on every table that stores a
 * real `email` column: customer, cart, "order", "user", pos_user, account_holder,
 * invite. Any INSERT or UPDATE touching the email column is normalized via a
 * BEFORE trigger, regardless of which API path, admin UI, or script wrote the row.
 *
 * This is the final defense-in-depth layer against zombie customers, duplicate
 * admin users, and payment-identity mismatches caused by case-sensitive lookups
 * (Medusa's findOrCreateCustomerStep and auth actor resolution are both case
 * sensitive).
 *
 * NOT covered (JSONB sub-fields — triggers cannot easily normalize nested JSON):
 *   - customer.metadata.cc_emails
 *   - customer.metadata.alt_email
 *   - auth_identity.provider_metadata.email
 * These remain guarded at the application layer.
 */
export class AddLowercaseEmailTriggers1776000000000
  implements MigrationInterface
{
  name = "AddLowercaseEmailTriggers1776000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION lowercase_email_trigger() RETURNS trigger AS $$
      BEGIN
        IF NEW.email IS NOT NULL THEN
          NEW.email = LOWER(NEW.email);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS customer_email_lowercase ON customer;
      CREATE TRIGGER customer_email_lowercase
      BEFORE INSERT OR UPDATE OF email ON customer
      FOR EACH ROW EXECUTE FUNCTION lowercase_email_trigger();
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS cart_email_lowercase ON cart;
      CREATE TRIGGER cart_email_lowercase
      BEFORE INSERT OR UPDATE OF email ON cart
      FOR EACH ROW EXECUTE FUNCTION lowercase_email_trigger();
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS order_email_lowercase ON "order";
      CREATE TRIGGER order_email_lowercase
      BEFORE INSERT OR UPDATE OF email ON "order"
      FOR EACH ROW EXECUTE FUNCTION lowercase_email_trigger();
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS user_email_lowercase ON "user";
      CREATE TRIGGER user_email_lowercase
      BEFORE INSERT OR UPDATE OF email ON "user"
      FOR EACH ROW EXECUTE FUNCTION lowercase_email_trigger();
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS pos_user_email_lowercase ON pos_user;
      CREATE TRIGGER pos_user_email_lowercase
      BEFORE INSERT OR UPDATE OF email ON pos_user
      FOR EACH ROW EXECUTE FUNCTION lowercase_email_trigger();
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS account_holder_email_lowercase ON account_holder;
      CREATE TRIGGER account_holder_email_lowercase
      BEFORE INSERT OR UPDATE OF email ON account_holder
      FOR EACH ROW EXECUTE FUNCTION lowercase_email_trigger();
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS invite_email_lowercase ON invite;
      CREATE TRIGGER invite_email_lowercase
      BEFORE INSERT OR UPDATE OF email ON invite
      FOR EACH ROW EXECUTE FUNCTION lowercase_email_trigger();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS invite_email_lowercase ON invite;`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS account_holder_email_lowercase ON account_holder;`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS pos_user_email_lowercase ON pos_user;`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS user_email_lowercase ON "user";`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS order_email_lowercase ON "order";`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS cart_email_lowercase ON cart;`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS customer_email_lowercase ON customer;`
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS lowercase_email_trigger;`);
  }
}
