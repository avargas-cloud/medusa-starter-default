import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/** Bank feed evidence only. No accounting, Treasury, finance or QB tables are changed. */
export class Migration20260908193000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS bank_connection (
        id text PRIMARY KEY,
        provider text NOT NULL,
        environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
        provider_item_id text NOT NULL,
        access_token_encrypted text NULL,
        institution_id text NULL,
        institution_name text NULL,
        status text NOT NULL DEFAULT 'awaiting_selection'
          CHECK (status IN ('awaiting_selection', 'active', 'reauth_required', 'disconnected', 'error')),
        cursor text NULL,
        initial_sync_complete boolean NOT NULL DEFAULT false,
        historical_sync_complete boolean NOT NULL DEFAULT false,
        consent_expiration_time timestamptz NULL,
        pending_disconnect boolean NOT NULL DEFAULT false,
        sync_requested_at timestamptz NULL,
        last_successful_sync_at timestamptz NULL,
        last_error_code text NULL,
        last_error_message text NULL,
        refresh_requested_at timestamptz NULL,
        refresh_completed_at timestamptz NULL,
        created_by text NULL,
        linked_public_token_hash text NULL,
        metadata jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        CONSTRAINT uq_bank_connection_identity UNIQUE (provider, environment, provider_item_id),
        CONSTRAINT uq_bank_connection_public_token UNIQUE (linked_public_token_hash)
      );
    `);
    this.addSql(`
      CREATE TABLE IF NOT EXISTS bank_account (
        id text PRIMARY KEY,
        connection_id text NOT NULL REFERENCES bank_connection(id) ON DELETE RESTRICT,
        provider_account_id text NOT NULL,
        persistent_account_id text NULL,
        name text NOT NULL,
        official_name text NULL,
        mask text NULL,
        type text NOT NULL,
        subtype text NULL,
        currency text NULL,
        qb_list_id text NULL,
        is_active boolean NOT NULL DEFAULT true,
        is_selected boolean NOT NULL DEFAULT false,
        balances jsonb NULL,
        balance_updated_at timestamptz NULL,
        source_data jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        CONSTRAINT uq_bank_account_identity UNIQUE (connection_id, provider_account_id),
        CONSTRAINT uq_bank_account_connection UNIQUE (id, connection_id)
      );
    `);
    this.addSql(`
      CREATE TABLE IF NOT EXISTS bank_transaction (
        id text PRIMARY KEY,
        connection_id text NOT NULL REFERENCES bank_connection(id) ON DELETE RESTRICT,
        account_id text NOT NULL REFERENCES bank_account(id) ON DELETE RESTRICT,
        provider_transaction_id text NOT NULL,
        pending_transaction_id text NULL,
        amount text NOT NULL CHECK (amount ~ '^-?[0-9]+([.][0-9]+)?$'),
        currency text NULL,
        unofficial_currency text NULL,
        status text NOT NULL CHECK (status IN ('pending', 'posted', 'removed')),
        transaction_date text NOT NULL CHECK (transaction_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
        authorized_date text NULL CHECK (authorized_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
        name text NOT NULL,
        merchant_name text NULL,
        source_data jsonb NOT NULL,
        source_revisions jsonb NOT NULL DEFAULT '[]'::jsonb
          CHECK (jsonb_typeof(source_revisions) = 'array'),
        first_seen_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL,
        removed_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        CONSTRAINT uq_bank_transaction_identity UNIQUE (connection_id, provider_transaction_id),
        CONSTRAINT fk_bank_transaction_account_connection
          FOREIGN KEY (account_id, connection_id) REFERENCES bank_account(id, connection_id)
          ON DELETE RESTRICT
      );
    `);
    this.addSql(`
      CREATE TABLE IF NOT EXISTS bank_sync_run (
        id text PRIMARY KEY,
        connection_id text NOT NULL REFERENCES bank_connection(id) ON DELETE RESTRICT,
        trigger text NOT NULL CHECK (trigger IN ('initial', 'webhook', 'scheduled', 'manual')),
        status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
        started_at timestamptz NOT NULL,
        finished_at timestamptz NULL,
        error_code text NULL,
        error_message text NULL,
        cursor_before text NULL,
        cursor_after text NULL,
        added_count integer NOT NULL DEFAULT 0 CHECK (added_count >= 0),
        modified_count integer NOT NULL DEFAULT 0 CHECK (modified_count >= 0),
        removed_count integer NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL
      );
    `);
    this.addSql(`
      CREATE TABLE IF NOT EXISTS bank_webhook_event (
        id text PRIMARY KEY,
        provider text NOT NULL,
        environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
        connection_id text NULL REFERENCES bank_connection(id) ON DELETE RESTRICT,
        event_digest text NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        received_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        last_error_code text NULL,
        last_error_message text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz NULL,
        CONSTRAINT uq_bank_webhook_event_digest UNIQUE (event_digest)
      );
    `);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_connection_sync
      ON bank_connection (sync_requested_at, id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_account_persistent
      ON bank_account (persistent_account_id) WHERE persistent_account_id IS NOT NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_account_active_qb
      ON bank_account (qb_list_id) WHERE qb_list_id IS NOT NULL AND is_active AND deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_transaction_account_date
      ON bank_transaction (account_id, transaction_date, id) WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_sync_run_connection_started
      ON bank_sync_run (connection_id, started_at DESC, id);`);
    this.addSql(`CREATE INDEX IF NOT EXISTS idx_bank_webhook_event_pending
      ON bank_webhook_event (status, received_at, id) WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql("DROP TABLE IF EXISTS bank_webhook_event;");
    this.addSql("DROP TABLE IF EXISTS bank_sync_run;");
    this.addSql("DROP TABLE IF EXISTS bank_transaction;");
    this.addSql("DROP TABLE IF EXISTS bank_account;");
    this.addSql("DROP TABLE IF EXISTS bank_connection;");
  }
}
