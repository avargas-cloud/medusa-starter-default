import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/** Extend the existing journal without rewriting any v8 entry or snapshot. */
export class Migration20260909040000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE bank_accounting_setup (
      id text PRIMARY KEY CHECK(id='local-usd'), revision integer NOT NULL CHECK(revision>0),
      cut_date text NOT NULL CHECK(cut_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND cut_date::date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
      currency text NOT NULL CHECK(currency='USD'), ar_account_list_id text NOT NULL,
      clearing_account_list_id text NOT NULL, ar_account_snapshot jsonb NOT NULL,
      clearing_account_snapshot jsonb NOT NULL, attested boolean NOT NULL CHECK(attested), actor_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
      CHECK(ar_account_list_id<>clearing_account_list_id));
      CREATE TABLE bank_receipt_accounting (
      id text PRIMARY KEY,payment_id text NOT NULL UNIQUE,setup_id text NOT NULL REFERENCES bank_accounting_setup(id),
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
      ALTER TABLE bank_journal_entry ALTER COLUMN expense_id DROP NOT NULL,ALTER COLUMN transaction_id DROP NOT NULL,
        ADD COLUMN receipt_id text REFERENCES bank_receipt_accounting(id),ADD COLUMN deposit_id text REFERENCES bank_deposit(id);
      ALTER TABLE bank_journal_entry DROP CONSTRAINT bank_journal_entry_kind_check,DROP CONSTRAINT bank_journal_entry_check;
      ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_kind CHECK(kind IN ('expense','receipt','deposit','payment_match','reversal')),
        ADD CONSTRAINT bank_journal_reverse_shape CHECK((kind<>'reversal' AND reverses_entry_id IS NULL AND reason IS NULL)
          OR (kind='reversal' AND reverses_entry_id IS NOT NULL AND reason IS NOT NULL AND length(trim(reason))>0));
      ALTER TABLE bank_journal_line DROP CONSTRAINT bank_journal_line_role_check;
      ALTER TABLE bank_journal_line ADD CONSTRAINT bank_journal_role CHECK(role IN ('bank','expense','clearing','receivable'));
      CREATE TABLE bank_receipt_consumption (
      id text PRIMARY KEY,entry_id text NOT NULL REFERENCES bank_journal_entry(id),
      receipt_id text NOT NULL REFERENCES bank_receipt_accounting(id),payment_id text NOT NULL,
      amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),
      origin_kind text NOT NULL CHECK(origin_kind IN ('deposit','payment_match')),origin_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
      UNIQUE(entry_id,payment_id));
      CREATE INDEX idx_bank_receipt_consumption_payment ON bank_receipt_consumption(payment_id,entry_id);
      CREATE INDEX idx_bank_journal_receipt ON bank_journal_entry(receipt_id,created_at);
      CREATE INDEX idx_bank_journal_deposit ON bank_journal_entry(deposit_id,created_at);
      CREATE TRIGGER bank_receipt_consumption_immutable BEFORE UPDATE OR DELETE ON bank_receipt_consumption
        FOR EACH ROW EXECUTE FUNCTION bank_journal_immutable();
      CREATE TRIGGER bank_receipt_accounting_immutable BEFORE UPDATE OR DELETE ON bank_receipt_accounting
        FOR EACH ROW EXECUTE FUNCTION bank_journal_immutable();`);
    this.addSql(`CREATE OR REPLACE FUNCTION bank_accounting_setup_frozen() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
      IF EXISTS(SELECT 1 FROM bank_receipt_accounting) THEN RAISE EXCEPTION 'BANKING_RECEIPT_SETUP_FROZEN'; END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
      CREATE TRIGGER bank_accounting_setup_frozen BEFORE UPDATE OR DELETE ON bank_accounting_setup
        FOR EACH ROW EXECUTE FUNCTION bank_accounting_setup_frozen();`);
    this.addSql(`CREATE OR REPLACE FUNCTION bank_journal_claim_source() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE source_id text; original bank_journal_entry%ROWTYPE; effective_kind text;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        effective_kind:=NEW.kind;
        IF NEW.kind='reversal' THEN
          SELECT * INTO original FROM bank_journal_entry WHERE id=NEW.reverses_entry_id;
          IF original.id IS NULL OR original.kind='reversal'
            OR original.expense_id IS DISTINCT FROM NEW.expense_id OR original.transaction_id IS DISTINCT FROM NEW.transaction_id
            OR original.receipt_id IS DISTINCT FROM NEW.receipt_id OR original.deposit_id IS DISTINCT FROM NEW.deposit_id
            OR original.amount_cents<>NEW.amount_cents OR original.source_hash<>NEW.source_hash
            OR original.source_snapshot<>NEW.source_snapshot OR NEW.day<original.day
          THEN RAISE EXCEPTION 'BANKING_REVERSAL_INVALID'; END IF;
          effective_kind:=original.kind;
          IF effective_kind='receipt' AND EXISTS(SELECT 1 FROM bank_receipt_consumption c
            WHERE c.receipt_id=NEW.receipt_id AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=c.entry_id))
          THEN RAISE EXCEPTION 'BANKING_RECEIPT_CONSUMED'; END IF;
        END IF;
        IF effective_kind='expense' THEN
          SELECT transaction_id INTO source_id FROM bank_direct_expense WHERE id=NEW.expense_id FOR UPDATE;
          IF source_id IS NULL OR source_id IS DISTINCT FROM NEW.transaction_id OR NEW.receipt_id IS NOT NULL OR NEW.deposit_id IS NOT NULL
          THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
        ELSIF effective_kind='receipt' THEN
          PERFORM 1 FROM bank_receipt_accounting WHERE id=NEW.receipt_id FOR UPDATE;
          IF NOT FOUND OR NEW.expense_id IS NOT NULL OR NEW.transaction_id IS NOT NULL OR NEW.deposit_id IS NOT NULL
          THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
        ELSIF effective_kind='deposit' THEN
          PERFORM 1 FROM bank_deposit WHERE id=NEW.deposit_id FOR UPDATE;
          IF NOT FOUND OR NEW.expense_id IS NOT NULL OR NEW.receipt_id IS NOT NULL OR NEW.transaction_id IS NOT NULL
          THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
        ELSIF effective_kind='payment_match' THEN
          PERFORM 1 FROM bank_transaction WHERE id=NEW.transaction_id FOR UPDATE;
          IF NOT FOUND OR NEW.expense_id IS NOT NULL OR NEW.receipt_id IS NOT NULL OR NEW.deposit_id IS NOT NULL
          THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
        END IF;
        IF NEW.kind<>'reversal' AND EXISTS(SELECT 1 FROM bank_journal_entry e WHERE e.kind<>'reversal'
          AND ((NEW.transaction_id IS NOT NULL AND e.transaction_id=NEW.transaction_id)
            OR (NEW.receipt_id IS NOT NULL AND e.receipt_id=NEW.receipt_id)
            OR (NEW.deposit_id IS NOT NULL AND e.deposit_id=NEW.deposit_id))
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
        THEN RAISE EXCEPTION 'BANKING_ALREADY_POSTED'; END IF;
        RETURN NEW;
      END $$;`);
    this.addSql(`CREATE OR REPLACE FUNCTION bank_journal_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE entry bank_journal_entry%ROWTYPE; original bank_journal_entry%ROWTYPE; target text;
        n integer; deb numeric; cred numeric; effective_kind text; expected_roles text[];
      BEGIN
        IF TG_TABLE_NAME='bank_journal_entry' THEN target:=NEW.id; ELSE target:=NEW.entry_id; END IF;
        SELECT * INTO entry FROM bank_journal_entry WHERE id=target;
        effective_kind:=entry.kind;
        IF entry.kind='reversal' THEN SELECT * INTO original FROM bank_journal_entry WHERE id=entry.reverses_entry_id;
          effective_kind:=original.kind; END IF;
        expected_roles:=CASE effective_kind WHEN 'expense' THEN ARRAY['bank','expense']
          WHEN 'receipt' THEN ARRAY['clearing','receivable'] WHEN 'payment_match' THEN ARRAY['bank','clearing']
          ELSE CASE WHEN EXISTS(SELECT 1 FROM bank_journal_line WHERE entry_id=target AND role='expense')
            THEN ARRAY['bank','clearing','expense'] ELSE ARRAY['bank','clearing'] END END;
        SELECT COUNT(*),COALESCE(SUM(debit_cents),0),COALESCE(SUM(credit_cents),0) INTO n,deb,cred
          FROM bank_journal_line WHERE entry_id=target;
        IF n<>cardinality(expected_roles) OR deb<>entry.amount_cents OR cred<>entry.amount_cents
          OR (SELECT array_agg(role ORDER BY role) FROM bank_journal_line WHERE entry_id=target) IS DISTINCT FROM expected_roles
          OR (SELECT COUNT(DISTINCT account_list_id) FROM bank_journal_line WHERE entry_id=target)<>n
          OR EXISTS(SELECT 1 FROM bank_journal_line l WHERE l.entry_id=target AND (
            l.account_snapshot->>'currency' IS DISTINCT FROM 'USD' OR l.account_list_id IS DISTINCT FROM l.account_snapshot->>'id'
            OR (l.role='bank' AND l.account_snapshot->>'account_type' IS DISTINCT FROM 'Bank')
            OR (l.role='clearing' AND l.account_snapshot->>'account_type' IS DISTINCT FROM 'OtherCurrentAsset')
            OR (l.role='receivable' AND l.account_snapshot->>'account_type' IS DISTINCT FROM 'AccountsReceivable')
            OR (l.role='expense' AND COALESCE(l.account_snapshot->>'account_type','') NOT IN ('Expense','OtherExpense'))
            OR ((CASE effective_kind WHEN 'expense' THEN l.role='expense' WHEN 'receipt' THEN l.role='clearing'
              ELSE l.role IN ('bank','expense') END) <> (entry.kind='reversal')) IS DISTINCT FROM (l.debit_cents>0)))
        THEN RAISE EXCEPTION 'BANKING_JOURNAL_UNBALANCED'; END IF;
        IF entry.kind='reversal' THEN
          IF EXISTS(SELECT 1 FROM (SELECT * FROM bank_journal_line WHERE entry_id=target) l FULL JOIN
            (SELECT * FROM bank_journal_line WHERE entry_id=entry.reverses_entry_id) o ON o.role=l.role
            WHERE (l.entry_id=target OR l.id IS NULL) AND (l.id IS NULL OR o.id IS NULL OR l.account_list_id<>o.account_list_id
              OR l.account_snapshot<>o.account_snapshot OR l.debit_cents<>o.credit_cents OR l.credit_cents<>o.debit_cents))
          THEN RAISE EXCEPTION 'BANKING_REVERSAL_INVALID'; END IF;
        ELSIF effective_kind IN ('deposit','payment_match') THEN
          IF (SELECT COALESCE(SUM(amount_cents),0) FROM bank_receipt_consumption WHERE entry_id=target)<>entry.amount_cents
            OR (effective_kind='payment_match' AND (SELECT COUNT(*) FROM bank_receipt_consumption WHERE entry_id=target)<>1)
          THEN RAISE EXCEPTION 'BANKING_RECEIPT_CONSUMPTION_INVALID'; END IF;
        END IF;
        RETURN NULL;
      END $$;`);
    this.addSql(`CREATE OR REPLACE FUNCTION bank_receipt_check_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE entry bank_journal_entry%ROWTYPE; receipt bank_journal_entry%ROWTYPE; source_id text; consumed numeric;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        SELECT payment_id INTO source_id FROM bank_receipt_accounting WHERE id=NEW.receipt_id FOR UPDATE;
        SELECT * INTO entry FROM bank_journal_entry WHERE id=NEW.entry_id;
        SELECT * INTO receipt FROM bank_journal_entry e WHERE e.receipt_id=NEW.receipt_id AND e.kind='receipt'
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id);
        IF source_id IS DISTINCT FROM NEW.payment_id OR receipt.id IS NULL OR entry.kind<>NEW.origin_kind
          OR NEW.origin_id IS DISTINCT FROM (CASE entry.kind WHEN 'deposit' THEN entry.deposit_id
            WHEN 'payment_match' THEN entry.transaction_id ELSE NULL END) OR entry.day<receipt.day
          OR EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=NEW.entry_id)
          OR (entry.kind='payment_match' AND NEW.amount_cents<>receipt.amount_cents)
        THEN RAISE EXCEPTION 'BANKING_RECEIPT_CONSUMPTION_INVALID'; END IF;
        SELECT COALESCE(SUM(c.amount_cents),0) INTO consumed FROM bank_receipt_consumption c WHERE c.receipt_id=NEW.receipt_id
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=c.entry_id);
        IF consumed>receipt.amount_cents THEN RAISE EXCEPTION 'BANKING_RECEIPT_OVERCONSUMED'; END IF;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER bank_receipt_consumption_valid AFTER INSERT ON bank_receipt_consumption
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_receipt_check_consumption();
      CREATE CONSTRAINT TRIGGER bank_receipt_consumption_balance AFTER INSERT ON bank_receipt_consumption
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_journal_check_balance();`);
  }
  override async down(): Promise<void> {
    throw new Error("Banking v9 rollback requires explicit reviewed migration; reverse posted entries instead.");
  }
}
