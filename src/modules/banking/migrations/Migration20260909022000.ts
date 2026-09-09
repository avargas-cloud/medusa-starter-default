import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/** Sandbox banking journal. No existing financial document is restated. */
export class Migration20260909022000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`ALTER TABLE bank_review_permission ADD COLUMN IF NOT EXISTS can_post boolean NOT NULL DEFAULT false;`);
    this.addSql(`CREATE TABLE bank_direct_expense (
      id text PRIMARY KEY, transaction_id text NOT NULL UNIQUE REFERENCES bank_transaction(id),
      revision integer NOT NULL CHECK(revision>0), nature text NOT NULL CHECK(nature='new_direct_expense'),
      reference text NOT NULL CHECK(length(trim(reference))>0), description text NOT NULL,
      attested boolean NOT NULL CHECK(attested), dismissals jsonb NOT NULL DEFAULT '[]',
      source_hash text NOT NULL, created_by text NOT NULL, updated_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz NULL
    );`);
    this.addSql(`CREATE TABLE bank_journal_entry (
      id text PRIMARY KEY, expense_id text NOT NULL REFERENCES bank_direct_expense(id),
      transaction_id text NOT NULL REFERENCES bank_transaction(id),
      kind text NOT NULL CHECK(kind IN ('expense','reversal')),
      day text NOT NULL CHECK(day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND day::date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
      currency text NOT NULL CHECK(currency='USD'), amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),
      source_hash text NOT NULL, source_snapshot jsonb NOT NULL, reference text NOT NULL,
      description text NOT NULL, actor_id text NOT NULL,
      reverses_entry_id text UNIQUE REFERENCES bank_journal_entry(id), reason text NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz NULL,
      CHECK((kind='expense' AND reverses_entry_id IS NULL AND reason IS NULL)
         OR (kind='reversal' AND reverses_entry_id IS NOT NULL AND length(trim(reason))>0))
    );`);
    this.addSql(`CREATE TABLE bank_journal_line (
      id text PRIMARY KEY, entry_id text NOT NULL REFERENCES bank_journal_entry(id),
      role text NOT NULL CHECK(role IN ('expense','bank')), account_list_id text NOT NULL,
      account_snapshot jsonb NOT NULL, debit_cents bigint NOT NULL CHECK(debit_cents>=0),
      credit_cents bigint NOT NULL CHECK(credit_cents>=0),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz NULL,
      UNIQUE(entry_id,role), CHECK((debit_cents>0 AND credit_cents=0) OR (credit_cents>0 AND debit_cents=0))
    );`);
    this.addSql(`CREATE INDEX idx_bank_journal_day ON bank_journal_entry(day,id);
      CREATE INDEX idx_bank_journal_source ON bank_journal_entry(transaction_id,created_at,id);`);
    this.addSql(`CREATE FUNCTION bank_journal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'BANKING_JOURNAL_IMMUTABLE'; END $$;
      CREATE TRIGGER bank_journal_entry_immutable BEFORE UPDATE OR DELETE ON bank_journal_entry
        FOR EACH ROW EXECUTE FUNCTION bank_journal_immutable();
      CREATE TRIGGER bank_journal_line_immutable BEFORE UPDATE OR DELETE ON bank_journal_line
        FOR EACH ROW EXECUTE FUNCTION bank_journal_immutable();`);
    this.addSql(`CREATE FUNCTION bank_journal_claim_source() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE source_id text; original bank_journal_entry%ROWTYPE;
      BEGIN
        SELECT transaction_id INTO source_id FROM bank_direct_expense WHERE id=NEW.expense_id FOR UPDATE;
        IF source_id IS DISTINCT FROM NEW.transaction_id THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
        IF NEW.kind='expense' THEN
          IF EXISTS(SELECT 1 FROM bank_journal_entry e WHERE e.transaction_id=NEW.transaction_id AND e.kind='expense'
            AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
          THEN RAISE EXCEPTION 'BANKING_ALREADY_POSTED'; END IF;
        ELSE
          SELECT * INTO original FROM bank_journal_entry WHERE id=NEW.reverses_entry_id;
          IF original.kind IS DISTINCT FROM 'expense' OR original.expense_id IS DISTINCT FROM NEW.expense_id
             OR original.transaction_id IS DISTINCT FROM NEW.transaction_id OR original.amount_cents IS DISTINCT FROM NEW.amount_cents
             OR original.source_hash IS DISTINCT FROM NEW.source_hash OR original.source_snapshot IS DISTINCT FROM NEW.source_snapshot
             OR NEW.day<original.day THEN RAISE EXCEPTION 'BANKING_REVERSAL_INVALID'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bank_journal_source_claim BEFORE INSERT ON bank_journal_entry
        FOR EACH ROW EXECUTE FUNCTION bank_journal_claim_source();`);
    this.addSql(`CREATE FUNCTION bank_journal_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE entry bank_journal_entry%ROWTYPE; target text; n integer; deb numeric; cred numeric;
      BEGIN
        IF TG_TABLE_NAME='bank_journal_entry' THEN target:=NEW.id; ELSE target:=NEW.entry_id; END IF;
        SELECT * INTO entry FROM bank_journal_entry WHERE id=target;
        SELECT COUNT(*),COALESCE(SUM(debit_cents),0),COALESCE(SUM(credit_cents),0) INTO n,deb,cred
          FROM bank_journal_line WHERE entry_id=target;
        IF n<>2 OR deb<>entry.amount_cents OR cred<>entry.amount_cents
          OR EXISTS(SELECT 1 FROM bank_journal_line l WHERE l.entry_id=target AND (
            (l.role='bank' AND l.account_snapshot->>'account_type' IS DISTINCT FROM 'Bank') OR
            (l.role='expense' AND COALESCE(l.account_snapshot->>'account_type','') NOT IN ('Expense','OtherExpense')) OR
            l.account_snapshot->>'currency' IS DISTINCT FROM 'USD' OR
            l.account_list_id IS DISTINCT FROM l.account_snapshot->>'id' OR
            ((entry.kind='expense')=(l.role='expense')) IS DISTINCT FROM (l.debit_cents>0)))
          OR (SELECT COUNT(DISTINCT account_list_id) FROM bank_journal_line WHERE entry_id=target)<>2
        THEN RAISE EXCEPTION 'BANKING_JOURNAL_UNBALANCED'; END IF;
        IF entry.kind='reversal' AND EXISTS(
          SELECT 1 FROM bank_journal_line l JOIN bank_journal_line o ON o.entry_id=entry.reverses_entry_id AND o.role=l.role
          WHERE l.entry_id=target AND (l.account_list_id<>o.account_list_id OR l.account_snapshot<>o.account_snapshot
            OR l.debit_cents<>o.credit_cents OR l.credit_cents<>o.debit_cents))
        THEN RAISE EXCEPTION 'BANKING_REVERSAL_INVALID'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER bank_journal_entry_balance AFTER INSERT ON bank_journal_entry
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_journal_check_balance();
      CREATE CONSTRAINT TRIGGER bank_journal_line_balance AFTER INSERT ON bank_journal_line
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_journal_check_balance();`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS bank_journal_line;
      DROP TABLE IF EXISTS bank_journal_entry;
      DROP TABLE IF EXISTS bank_direct_expense;
      DROP FUNCTION IF EXISTS bank_journal_check_balance();
      DROP FUNCTION IF EXISTS bank_journal_claim_source();
      DROP FUNCTION IF EXISTS bank_journal_immutable();
      ALTER TABLE bank_review_permission DROP COLUMN IF EXISTS can_post;`);
  }
}
