import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/** Daily bank review evidence only; no financial or QuickBooks postings. */
export class Migration20260908223000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE bank_account
      ADD COLUMN IF NOT EXISTS review_start_date text NULL,
      ADD COLUMN IF NOT EXISTS opening_bank_balance text NULL,
      ADD COLUMN IF NOT EXISTS opening_balance_date text NULL,
      ADD COLUMN IF NOT EXISTS opening_reference text NULL,
      ADD COLUMN IF NOT EXISTS opening_book_balance text NULL,
      ADD COLUMN IF NOT EXISTS setup_revision integer NOT NULL DEFAULT 0;`);
    this.addSql(`ALTER TABLE bank_transaction
      ADD COLUMN IF NOT EXISTS source_version integer NOT NULL DEFAULT 1;`);
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_review_rule (
      id text PRIMARY KEY,
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      name text NOT NULL,
      account_id text NOT NULL REFERENCES bank_account(id) ON DELETE RESTRICT,
      active boolean NOT NULL DEFAULT true,
      priority integer NOT NULL DEFAULT 100,
      match_field text NOT NULL CHECK (match_field IN ('merchant','description')),
      pattern text NOT NULL,
      direction text NOT NULL CHECK (direction IN ('in','out')),
      currency text NOT NULL,
      category_list_id text NOT NULL,
      counterparty_type text NULL CHECK (counterparty_type IN ('vendor','customer')),
      counterparty_id text NULL,
      counterparty_name text NULL,
      created_by text NOT NULL,
      updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL
    );`);
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_transaction_review (
      id text PRIMARY KEY,
      transaction_id text NOT NULL UNIQUE REFERENCES bank_transaction(id) ON DELETE RESTRICT,
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      source_version integer NOT NULL CHECK (source_version > 0),
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','excluded')),
      mode text NOT NULL DEFAULT 'categorize' CHECK (mode IN ('categorize','match')),
      category_list_id text NULL,
      counterparty_type text NULL CHECK (counterparty_type IN ('vendor','customer')),
      counterparty_id text NULL,
      counterparty_name text NULL,
      comment text NOT NULL DEFAULT '',
      matched_payment_id text NULL,
      match_snapshot jsonb NULL,
      category_snapshot jsonb NULL,
      origin text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','rule')),
      rule_id text NULL REFERENCES bank_review_rule(id) ON DELETE RESTRICT,
      rule_version integer NULL,
      manual_override boolean NOT NULL DEFAULT false,
      confirmed_by text NULL,
      confirmed_at timestamptz NULL,
      exclusion_reason text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL
    );`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_review_active_payment
      ON bank_transaction_review (matched_payment_id)
      WHERE matched_payment_id IS NOT NULL AND status <> 'excluded' AND deleted_at IS NULL;`);
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_review_event (
      id text PRIMARY KEY,
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      transaction_id text NULL REFERENCES bank_transaction(id) ON DELETE RESTRICT,
      action text NOT NULL,
      actor_id text NOT NULL,
      details jsonb NOT NULL,
      idempotency_key text NULL UNIQUE,
      request_hash text NULL,
      result jsonb NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL
    );`);
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_day_close (
      id text PRIMARY KEY,
      day text NOT NULL UNIQUE CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      snapshot jsonb NULL,
      input_hash text NULL,
      closed_by text NULL,
      closed_at timestamptz NULL,
      reopened_by text NULL,
      reopened_at timestamptz NULL,
      reopen_reason text NULL,
      needs_review boolean NOT NULL DEFAULT false,
      history jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history)='array'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL
    );`);
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_review_attachment (
      id text PRIMARY KEY,
      transaction_id text NOT NULL REFERENCES bank_transaction(id) ON DELETE RESTRICT,
      original_name text NOT NULL,
      mime_type text NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','application/pdf')),
      size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
      sha256 text NOT NULL,
      content_base64 text NOT NULL CHECK (length(content_base64) BETWEEN 4 AND 6990508),
      uploaded_by text NOT NULL,
      detached_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL
    );`);
    this.addSql(`CREATE TABLE IF NOT EXISTS bank_review_permission (
      id text PRIMARY KEY,
      user_id text NOT NULL UNIQUE,
      can_review boolean NOT NULL DEFAULT false,
      can_close boolean NOT NULL DEFAULT false,
      granted_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL
    );`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_review_rule_priority
      ON bank_review_rule (account_id, priority, id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_review_event_entity
      ON bank_review_event (entity_type, entity_id, created_at, id);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_review_event_transaction
      ON bank_review_event (transaction_id, created_at, id) WHERE transaction_id IS NOT NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_review_attachment_transaction
      ON bank_review_attachment (transaction_id, created_at, id);`);
  }

  override async down(): Promise<void> {
    this.addSql("DROP TABLE IF EXISTS bank_review_permission;");
    this.addSql("DROP TABLE IF EXISTS bank_review_attachment;");
    this.addSql("DROP TABLE IF EXISTS bank_day_close;");
    this.addSql("DROP TABLE IF EXISTS bank_review_event;");
    this.addSql("DROP TABLE IF EXISTS bank_transaction_review;");
    this.addSql("DROP TABLE IF EXISTS bank_review_rule;");
    this.addSql("ALTER TABLE bank_transaction DROP COLUMN IF EXISTS source_version;");
    this.addSql(`ALTER TABLE bank_account DROP COLUMN IF EXISTS review_start_date,
      DROP COLUMN IF EXISTS opening_bank_balance, DROP COLUMN IF EXISTS opening_balance_date,
      DROP COLUMN IF EXISTS opening_reference, DROP COLUMN IF EXISTS opening_book_balance,
      DROP COLUMN IF EXISTS setup_revision;`);
  }
}
