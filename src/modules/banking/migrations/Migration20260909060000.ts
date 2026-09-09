import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/** Documented baselines are not journal entries; existing journal rows remain untouched. */
export class Migration20260909060000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE bank_opening_evidence (
      id text PRIMARY KEY,original_name text NOT NULL,mime_type text NOT NULL CHECK(mime_type='application/pdf'),
      size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),sha256 text NOT NULL,
      content_base64 text NOT NULL,uploaded_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
      CREATE TABLE bank_opening_balance (
      id text PRIMARY KEY,revision integer NOT NULL CHECK(revision>0),kind text NOT NULL CHECK(kind IN ('bank','clearing')),
      status text NOT NULL CHECK(status IN ('draft','adopted','revoked')),setup_id text NOT NULL REFERENCES bank_accounting_setup(id),
      cut_date text NOT NULL CHECK(cut_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND cut_date::date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
      bank_account_id text REFERENCES bank_account(id),account_list_id text NOT NULL,currency text NOT NULL CHECK(currency='USD'),
      account_snapshot jsonb NOT NULL,book_balance_cents bigint CHECK(abs(book_balance_cents)<=999999999999),
      statement_balance_cents bigint CHECK(abs(statement_balance_cents)<=999999999999),reference text NOT NULL DEFAULT '',
      statement_evidence_id text REFERENCES bank_opening_evidence(id),books_evidence_id text REFERENCES bank_opening_evidence(id),
      adopted_by text,adopted_at timestamptz,revoked_by text,revoked_at timestamptz,revoke_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
      CHECK((kind='bank' AND bank_account_id IS NOT NULL) OR (kind='clearing' AND bank_account_id IS NULL)),
      CHECK(kind<>'clearing' OR (statement_balance_cents IS NULL AND book_balance_cents>=0)));
      CREATE UNIQUE INDEX uq_bank_opening_active ON bank_opening_balance(kind,account_list_id,cut_date)
        WHERE status='adopted' AND deleted_at IS NULL;
      CREATE TABLE bank_opening_item (
      id text PRIMARY KEY,opening_id text NOT NULL REFERENCES bank_opening_balance(id),
      kind text NOT NULL CHECK(kind IN ('uf_receipt','deposit_in_transit','outstanding_check')),
      original_day text NOT NULL CHECK(original_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND original_day::date BETWEEN DATE '1900-01-01' AND DATE '2200-12-31'),
      amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),external_key text NOT NULL,
      reference text NOT NULL,description text NOT NULL DEFAULT '',payment_id text,evidence_id text REFERENCES bank_opening_evidence(id),
      source_snapshot jsonb NOT NULL,source_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
      UNIQUE(opening_id,external_key),UNIQUE(opening_id,payment_id));
      CREATE UNIQUE INDEX uq_bank_opening_external_key ON bank_opening_item(opening_id,lower(trim(external_key)));
      CREATE TABLE bank_opening_clear (
      id text PRIMARY KEY,item_id text NOT NULL REFERENCES bank_opening_item(id),transaction_id text NOT NULL REFERENCES bank_transaction(id),
      kind text NOT NULL CHECK(kind IN ('clear','unclear')),reverses_clear_id text UNIQUE REFERENCES bank_opening_clear(id),
      source_version integer NOT NULL,item_hash text NOT NULL,source_snapshot jsonb NOT NULL,review_snapshot jsonb,
      actor_id text NOT NULL,reason text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
      CHECK((kind='clear' AND reverses_clear_id IS NULL) OR (kind='unclear' AND reverses_clear_id IS NOT NULL AND reason IS NOT NULL AND length(trim(reason))>0)));
      CREATE INDEX idx_bank_opening_clear_transaction ON bank_opening_clear(transaction_id,kind);
      ALTER TABLE bank_deposit_line ALTER COLUMN payment_id DROP NOT NULL,
        ADD COLUMN opening_item_id text REFERENCES bank_opening_item(id),
        ADD CONSTRAINT bank_deposit_funding_source CHECK((payment_id IS NULL)<>(opening_item_id IS NULL));
      CREATE UNIQUE INDEX uq_bank_deposit_opening_item ON bank_deposit_line(deposit_id,opening_item_id) WHERE deleted_at IS NULL;
      ALTER TABLE bank_receipt_consumption ALTER COLUMN receipt_id DROP NOT NULL,ALTER COLUMN payment_id DROP NOT NULL,
        ADD COLUMN opening_item_id text REFERENCES bank_opening_item(id),
        ADD CONSTRAINT bank_consumption_funding_source CHECK((receipt_id IS NOT NULL AND payment_id IS NOT NULL AND opening_item_id IS NULL)
          OR (receipt_id IS NULL AND payment_id IS NULL AND opening_item_id IS NOT NULL)),
        ADD CONSTRAINT bank_consumption_opening_unique UNIQUE(entry_id,opening_item_id);`);
    this.addSql(`CREATE FUNCTION bank_opening_reserved(source_id text,excluded_deposit text) RETURNS numeric LANGUAGE sql STABLE AS $$
      SELECT COALESCE((SELECT SUM(funding.cents) FROM (
    SELECT consumption.amount_cents::numeric AS cents FROM bank_receipt_consumption consumption
      WHERE consumption.opening_item_id=$1::text
        AND NOT(consumption.origin_kind='deposit' AND consumption.origin_id IS NOT DISTINCT FROM $2::text)
        AND NOT EXISTS(SELECT 1 FROM bank_journal_entry reversal WHERE reversal.reverses_entry_id=consumption.entry_id)
    UNION ALL SELECT line.amount::numeric*100 FROM bank_deposit_line line JOIN bank_deposit deposit ON deposit.id=line.deposit_id
      WHERE line.opening_item_id=$1::text AND line.deleted_at IS NULL AND deposit.deleted_at IS NULL AND deposit.status<>'void'
        AND deposit.id IS DISTINCT FROM $2::text
        AND NOT EXISTS(SELECT 1 FROM bank_receipt_consumption consumption WHERE consumption.opening_item_id=$1::text
          AND consumption.origin_kind='deposit' AND consumption.origin_id=deposit.id
          AND NOT EXISTS(SELECT 1 FROM bank_journal_entry reversal WHERE reversal.reverses_entry_id=consumption.entry_id))
    ) funding),0) $$;`);
    this.addSql(`CREATE FUNCTION bank_opening_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE parent bank_opening_balance%ROWTYPE; total numeric; plus numeric; minus numeric;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        IF TG_TABLE_NAME='bank_opening_item' THEN
          IF TG_OP<>'INSERT' THEN
            SELECT * INTO parent FROM bank_opening_balance WHERE id=OLD.opening_id;
            IF parent.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'BANKING_OPENING_IMMUTABLE'; END IF;
          END IF;
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          SELECT * INTO parent FROM bank_opening_balance WHERE id=NEW.opening_id;
          IF parent.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'BANKING_OPENING_IMMUTABLE'; END IF; RETURN NEW;
        END IF;
        IF TG_OP='DELETE' THEN IF OLD.status<>'draft' THEN RAISE EXCEPTION 'BANKING_OPENING_IMMUTABLE'; END IF; RETURN OLD; END IF;
        IF TG_OP='UPDATE' AND OLD.status<>'draft' THEN
          IF OLD.status<>'adopted' OR NEW.status<>'revoked'
            OR (to_jsonb(OLD)-ARRAY['status','revision','updated_at','revoked_by','revoked_at','revoke_reason'])
              IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','revision','updated_at','revoked_by','revoked_at','revoke_reason'])
            OR NEW.revoked_by IS NULL OR NEW.revoked_at IS NULL OR COALESCE(length(trim(NEW.revoke_reason)),0)=0
          THEN RAISE EXCEPTION 'BANKING_OPENING_IMMUTABLE'; END IF;
          IF EXISTS(SELECT 1 FROM bank_opening_item item JOIN bank_receipt_consumption c ON c.opening_item_id=item.id WHERE item.opening_id=NEW.id)
            OR EXISTS(SELECT 1 FROM bank_opening_item item JOIN bank_opening_clear c ON c.item_id=item.id WHERE item.opening_id=NEW.id)
            OR EXISTS(SELECT 1 FROM bank_opening_item item JOIN bank_deposit_line l ON l.opening_item_id=item.id
              JOIN bank_deposit d ON d.id=l.deposit_id WHERE item.opening_id=NEW.id AND l.deleted_at IS NULL AND d.deleted_at IS NULL AND d.status<>'void')
          THEN RAISE EXCEPTION 'BANKING_OPENING_DEPENDENCIES'; END IF;
        END IF;
        IF NEW.status='adopted' THEN
          IF NOT EXISTS(SELECT 1 FROM bank_accounting_setup setup WHERE setup.id=NEW.setup_id AND setup.cut_date=NEW.cut_date
            AND setup.currency='USD' AND (NEW.kind='bank' OR setup.clearing_account_list_id=NEW.account_list_id))
            OR (NEW.kind='bank' AND NOT EXISTS(SELECT 1 FROM bank_account a WHERE a.id=NEW.bank_account_id
              AND a.qb_list_id=NEW.account_list_id AND a.currency='USD' AND a.is_active AND a.is_selected AND a.deleted_at IS NULL))
          THEN RAISE EXCEPTION 'BANKING_OPENING_MAPPING_STALE'; END IF;
          IF NEW.adopted_by IS NULL OR NEW.adopted_at IS NULL OR NEW.book_balance_cents IS NULL OR NEW.books_evidence_id IS NULL
            OR (NEW.kind='bank' AND (NEW.statement_balance_cents IS NULL OR NEW.statement_evidence_id IS NULL))
          THEN RAISE EXCEPTION 'BANKING_OPENING_EVIDENCE_REQUIRED'; END IF;
          IF EXISTS(SELECT 1 FROM bank_opening_item item WHERE item.opening_id=NEW.id AND
            (item.original_day>=NEW.cut_date OR item.evidence_id IS NULL OR
             ((NEW.kind='clearing') IS DISTINCT FROM (item.kind='uf_receipt'))))
          THEN RAISE EXCEPTION 'BANKING_OPENING_ITEM_INVALID'; END IF;
          SELECT COALESCE(SUM(amount_cents),0),COALESCE(SUM(amount_cents) FILTER(WHERE kind='deposit_in_transit'),0),
            COALESCE(SUM(amount_cents) FILTER(WHERE kind='outstanding_check'),0) INTO total,plus,minus
            FROM bank_opening_item WHERE opening_id=NEW.id;
          IF (NEW.kind='clearing' AND total<>NEW.book_balance_cents)
            OR (NEW.kind='bank' AND NEW.book_balance_cents<>NEW.statement_balance_cents+plus-minus)
          THEN RAISE EXCEPTION 'BANKING_OPENING_UNBALANCED'; END IF;
          IF EXISTS(SELECT 1 FROM bank_opening_item item JOIN bank_opening_item other ON other.opening_id<>item.opening_id
            AND (lower(trim(other.external_key))=lower(trim(item.external_key)) OR (item.payment_id IS NOT NULL AND other.payment_id=item.payment_id))
            JOIN bank_opening_balance other_parent ON other_parent.id=other.opening_id AND other_parent.status='adopted'
            WHERE item.opening_id=NEW.id)
            OR EXISTS(SELECT 1 FROM bank_opening_item item JOIN bank_receipt_accounting a ON a.payment_id=item.payment_id WHERE item.opening_id=NEW.id)
            OR EXISTS(SELECT 1 FROM bank_opening_item item JOIN bank_deposit_line l ON l.payment_id=item.payment_id
              JOIN bank_deposit d ON d.id=l.deposit_id WHERE item.opening_id=NEW.id AND l.deleted_at IS NULL
              AND d.deleted_at IS NULL AND d.status IN ('draft','ready'))
            OR EXISTS(SELECT 1 FROM bank_opening_item item JOIN bank_transaction_review r ON r.matched_payment_id=item.payment_id
              WHERE item.opening_id=NEW.id AND r.deleted_at IS NULL AND r.status<>'excluded')
          THEN RAISE EXCEPTION 'BANKING_OPENING_SOURCE_ALREADY_CLAIMED'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bank_opening_balance_immutable BEFORE INSERT OR UPDATE OR DELETE ON bank_opening_balance
        FOR EACH ROW EXECUTE FUNCTION bank_opening_guard();
      CREATE TRIGGER bank_opening_item_immutable BEFORE INSERT OR UPDATE OR DELETE ON bank_opening_item
        FOR EACH ROW EXECUTE FUNCTION bank_opening_guard();
      CREATE TRIGGER bank_opening_clear_immutable BEFORE UPDATE OR DELETE ON bank_opening_clear FOR EACH ROW EXECUTE FUNCTION bank_journal_immutable();
      CREATE TRIGGER bank_opening_evidence_immutable BEFORE UPDATE OR DELETE ON bank_opening_evidence FOR EACH ROW EXECUTE FUNCTION bank_journal_immutable();`);
    this.addSql(`CREATE FUNCTION bank_opening_claim_clear() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item bank_opening_item%ROWTYPE; parent bank_opening_balance%ROWTYPE; tx bank_transaction%ROWTYPE; original bank_opening_clear%ROWTYPE; mapped text;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        SELECT * INTO item FROM bank_opening_item WHERE id=NEW.item_id;
        SELECT * INTO parent FROM bank_opening_balance WHERE id=item.opening_id;
        SELECT * INTO tx FROM bank_transaction WHERE id=NEW.transaction_id;
        SELECT qb_list_id INTO mapped FROM bank_account WHERE id=tx.account_id;
        IF NEW.kind='unclear' THEN
          SELECT * INTO original FROM bank_opening_clear WHERE id=NEW.reverses_clear_id;
          IF original.kind IS DISTINCT FROM 'clear' OR original.item_id<>NEW.item_id OR original.transaction_id<>NEW.transaction_id
          THEN RAISE EXCEPTION 'BANKING_OPENING_CLEAR_INVALID'; END IF;
        ELSE
          IF parent.status IS DISTINCT FROM 'adopted' OR parent.kind IS DISTINCT FROM 'bank' OR item.kind='uf_receipt'
            OR item.source_hash IS DISTINCT FROM NEW.item_hash OR tx.status IS DISTINCT FROM 'posted'
            OR tx.deleted_at IS NOT NULL OR tx.currency IS DISTINCT FROM 'USD' OR mapped IS DISTINCT FROM parent.account_list_id
            OR tx.source_version IS DISTINCT FROM NEW.source_version OR tx.transaction_date<parent.cut_date
            OR tx.amount::numeric*100 IS DISTINCT FROM (CASE item.kind WHEN 'outstanding_check' THEN item.amount_cents ELSE -item.amount_cents END)::numeric
          THEN RAISE EXCEPTION 'BANKING_OPENING_CLEAR_INVALID'; END IF;
          IF EXISTS(SELECT 1 FROM bank_opening_clear c WHERE c.kind='clear' AND (c.item_id=NEW.item_id OR c.transaction_id=NEW.transaction_id)
              AND NOT EXISTS(SELECT 1 FROM bank_opening_clear r WHERE r.reverses_clear_id=c.id))
            OR EXISTS(SELECT 1 FROM bank_journal_entry e WHERE e.transaction_id=NEW.transaction_id AND e.kind<>'reversal'
              AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
            OR EXISTS(SELECT 1 FROM bank_transaction_review r WHERE r.transaction_id=NEW.transaction_id AND r.deleted_at IS NULL
              AND (r.matched_payment_id IS NOT NULL OR r.matched_deposit_id IS NOT NULL))
          THEN RAISE EXCEPTION 'BANKING_OPENING_TRANSACTION_CLAIMED'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER bank_opening_clear_claim BEFORE INSERT ON bank_opening_clear FOR EACH ROW EXECUTE FUNCTION bank_opening_claim_clear();
      CREATE FUNCTION bank_opening_journal_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        IF NEW.kind<>'reversal' AND EXISTS(SELECT 1 FROM bank_opening_clear c WHERE c.transaction_id=NEW.transaction_id AND c.kind='clear'
          AND NOT EXISTS(SELECT 1 FROM bank_opening_clear r WHERE r.reverses_clear_id=c.id))
        THEN RAISE EXCEPTION 'BANKING_OPENING_TRANSACTION_CLAIMED'; END IF;
        IF NEW.kind='receipt' AND EXISTS(SELECT 1 FROM bank_receipt_accounting a JOIN bank_opening_item item ON item.payment_id=a.payment_id
          JOIN bank_opening_balance b ON b.id=item.opening_id AND b.status='adopted' WHERE a.id=NEW.receipt_id)
        THEN RAISE EXCEPTION 'BANKING_OPENING_PAYMENT_CLAIMED'; END IF;
        RETURN NEW; END $$;
      CREATE TRIGGER bank_opening_journal_claim BEFORE INSERT ON bank_journal_entry FOR EACH ROW EXECUTE FUNCTION bank_opening_journal_claim();`);
    this.addSql(`CREATE FUNCTION bank_opening_setup_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
      IF TG_TABLE_NAME='bank_accounting_setup' THEN
        IF EXISTS(SELECT 1 FROM bank_opening_balance WHERE status='adopted' AND setup_id=OLD.id)
        THEN RAISE EXCEPTION 'BANKING_RECEIPT_SETUP_FROZEN'; END IF;
      ELSIF TG_OP='DELETE' OR OLD.qb_list_id IS DISTINCT FROM NEW.qb_list_id
        OR OLD.review_start_date IS DISTINCT FROM NEW.review_start_date OR OLD.opening_bank_balance IS DISTINCT FROM NEW.opening_bank_balance
        OR OLD.opening_book_balance IS DISTINCT FROM NEW.opening_book_balance OR OLD.opening_reference IS DISTINCT FROM NEW.opening_reference THEN
        IF EXISTS(SELECT 1 FROM bank_opening_balance WHERE status='adopted' AND kind='bank' AND account_list_id=OLD.qb_list_id)
        THEN RAISE EXCEPTION 'BANKING_ACCOUNTING_SETUP_FROZEN'; END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
      CREATE TRIGGER bank_opening_setup_guard BEFORE UPDATE OR DELETE ON bank_accounting_setup FOR EACH ROW EXECUTE FUNCTION bank_opening_setup_guard();
      CREATE TRIGGER bank_opening_account_guard BEFORE UPDATE OR DELETE ON bank_account FOR EACH ROW EXECUTE FUNCTION bank_opening_setup_guard();
      CREATE FUNCTION bank_opening_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE source_id text; BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        source_id:=CASE WHEN TG_OP='DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END;
        IF EXISTS(SELECT 1 FROM bank_opening_clear c WHERE c.transaction_id=source_id AND c.kind='clear'
          AND NOT EXISTS(SELECT 1 FROM bank_opening_clear u WHERE u.reverses_clear_id=c.id))
        THEN RAISE EXCEPTION 'BANKING_OPENING_TRANSACTION_CLAIMED'; END IF;
        IF TG_OP<>'DELETE' AND NEW.matched_payment_id IS NOT NULL AND EXISTS(SELECT 1 FROM bank_opening_item item
          JOIN bank_opening_balance b ON b.id=item.opening_id WHERE item.payment_id=NEW.matched_payment_id AND b.status='adopted')
        THEN RAISE EXCEPTION 'BANKING_OPENING_PAYMENT_CLAIMED'; END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
      CREATE TRIGGER bank_opening_review_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_transaction_review
        FOR EACH ROW EXECUTE FUNCTION bank_opening_review_guard();
      CREATE FUNCTION bank_opening_deposit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE item bank_opening_item%ROWTYPE; parent bank_opening_balance%ROWTYPE; BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
        IF NEW.payment_id IS NOT NULL THEN
          IF EXISTS(SELECT 1 FROM bank_opening_item oi JOIN bank_opening_balance b ON b.id=oi.opening_id
            WHERE oi.payment_id=NEW.payment_id AND b.status='adopted')
          THEN RAISE EXCEPTION 'BANKING_OPENING_PAYMENT_CLAIMED'; END IF;
        ELSE
          SELECT * INTO item FROM bank_opening_item WHERE id=NEW.opening_item_id;
          SELECT * INTO parent FROM bank_opening_balance WHERE id=item.opening_id;
          IF item.kind IS DISTINCT FROM 'uf_receipt' OR parent.status IS DISTINCT FROM 'adopted'
            OR bank_opening_reserved(item.id,NEW.deposit_id)+NEW.amount::numeric*100>item.amount_cents
          THEN RAISE EXCEPTION 'BANKING_OPENING_CONSUMPTION_INVALID'; END IF;
        END IF; RETURN NEW; END $$;
      CREATE TRIGGER bank_opening_deposit_guard BEFORE INSERT OR UPDATE ON bank_deposit_line
        FOR EACH ROW EXECUTE FUNCTION bank_opening_deposit_guard();`);
    this.addSql(`CREATE OR REPLACE FUNCTION bank_receipt_check_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE entry bank_journal_entry%ROWTYPE; receipt bank_journal_entry%ROWTYPE; source_id text; consumed numeric;
        item bank_opening_item%ROWTYPE; parent bank_opening_balance%ROWTYPE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
        SELECT * INTO entry FROM bank_journal_entry WHERE id=NEW.entry_id;
        IF NEW.opening_item_id IS NOT NULL THEN
          SELECT * INTO item FROM bank_opening_item WHERE id=NEW.opening_item_id FOR UPDATE;
          SELECT * INTO parent FROM bank_opening_balance WHERE id=item.opening_id;
          IF item.kind IS DISTINCT FROM 'uf_receipt' OR parent.status IS DISTINCT FROM 'adopted' OR entry.kind<>'deposit'
            OR NEW.origin_kind<>'deposit' OR NEW.origin_id IS DISTINCT FROM entry.deposit_id OR entry.day<parent.cut_date
            OR EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=NEW.entry_id)
          THEN RAISE EXCEPTION 'BANKING_OPENING_CONSUMPTION_INVALID'; END IF;
          SELECT COALESCE(SUM(c.amount_cents),0) INTO consumed FROM bank_receipt_consumption c WHERE c.opening_item_id=item.id
            AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=c.entry_id);
          IF consumed>item.amount_cents OR bank_opening_reserved(item.id,entry.deposit_id)+NEW.amount_cents>item.amount_cents
          THEN RAISE EXCEPTION 'BANKING_RECEIPT_OVERCONSUMED'; END IF;
          RETURN NULL;
        END IF;
        SELECT payment_id INTO source_id FROM bank_receipt_accounting WHERE id=NEW.receipt_id FOR UPDATE;
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
      END $$;`);
  }
  override async down(): Promise<void> { throw new Error("Opening history requires explicit reviewed rollback, never implicit removal."); }
}
