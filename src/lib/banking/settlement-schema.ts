export const settlementSchemaSql = `
CREATE TABLE bank_merchant_settlement (
 id text PRIMARY KEY,revision integer NOT NULL CHECK(revision>0),processor text NOT NULL,merchant text NOT NULL,
 reference text NOT NULL,currency text NOT NULL CHECK(currency='USD'),payload jsonb NOT NULL,source_snapshot jsonb NOT NULL,
 created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
 CHECK(length(trim(processor))>0 AND length(trim(merchant))>0 AND length(trim(reference))>0));
CREATE UNIQUE INDEX uq_bank_merchant_settlement_identity ON bank_merchant_settlement
 (lower(trim(processor)),lower(trim(merchant)),lower(trim(reference)),currency);
CREATE TABLE bank_merchant_settlement_line (
 id text PRIMARY KEY,settlement_id text NOT NULL REFERENCES bank_merchant_settlement(id),sort_order integer NOT NULL CHECK(sort_order>=0),
 kind text NOT NULL CHECK(kind IN ('receipt','refund','chargeback','fee','reserve_hold','reserve_release')),
 source_id text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
 UNIQUE(settlement_id,sort_order),UNIQUE(settlement_id,kind,source_id));
CREATE FUNCTION bank_settlement_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; destination text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF TG_TABLE_NAME='bank_merchant_settlement' THEN target:=OLD.id;
 ELSE
   IF TG_OP<>'INSERT' THEN target:=OLD.settlement_id; END IF;
   IF TG_OP<>'DELETE' THEN destination:=NEW.settlement_id; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM bank_journal_entry WHERE completion_id IN (target,destination))
   THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER bank_settlement_immutable BEFORE UPDATE OR DELETE ON bank_merchant_settlement
 FOR EACH ROW EXECUTE FUNCTION bank_settlement_document_guard();
CREATE TRIGGER bank_settlement_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON bank_merchant_settlement_line
 FOR EACH ROW EXECUTE FUNCTION bank_settlement_document_guard();
CREATE FUNCTION bank_settlement_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document bank_merchant_settlement%ROWTYPE; docline bank_merchant_settlement_line%ROWTYPE;
 expected_account text; expected_debit bigint; expected_credit bigint; expected_role text; net numeric;
BEGIN
 IF NEW.kind<>'merchant_settlement' THEN RETURN NULL; END IF;
 SELECT * INTO document FROM bank_merchant_settlement WHERE id=NEW.completion_id;
 IF document.id IS NULL OR document.deleted_at IS NOT NULL OR NEW.completion_stage<>'settle'
   OR NEW.source_snapshot->'settlement' IS NULL
   OR NEW.source_snapshot->'settlement'->>'id' IS DISTINCT FROM document.id
   OR ((NEW.source_snapshot->'settlement') - ARRAY['id','revision','created_by','created_at']) IS DISTINCT FROM document.payload
   OR NEW.day IS DISTINCT FROM document.payload->>'day'
   THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
 SELECT COALESCE(sum(amount_cents * CASE WHEN kind IN ('receipt','reserve_release') THEN 1 ELSE -1 END),0) INTO net
   FROM bank_merchant_settlement_line WHERE settlement_id=document.id;
 IF (net=0 AND NEW.transaction_id IS NOT NULL) OR (net<>0 AND NEW.transaction_id IS NULL)
   THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_BANK_EVIDENCE_REQUIRED'; END IF;
 FOR docline IN SELECT * FROM bank_merchant_settlement_line WHERE settlement_id=document.id ORDER BY sort_order LOOP
   IF docline.payload IS DISTINCT FROM document.payload->'lines'->docline.sort_order
     THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
   expected_account:=docline.payload->>'account_list_id';
   expected_role:=(CASE WHEN docline.kind='fee' THEN 'expense_' ELSE 'counterpart_' END)||docline.sort_order::text;
   expected_credit:=CASE WHEN docline.kind IN ('receipt','reserve_release') THEN docline.amount_cents ELSE 0 END;
   expected_debit:=CASE WHEN docline.kind IN ('receipt','reserve_release') THEN 0 ELSE docline.amount_cents END;
   IF NOT EXISTS(SELECT 1 FROM bank_journal_line l WHERE l.entry_id=NEW.id AND l.role=expected_role
     AND l.account_list_id=expected_account AND l.debit_cents=expected_debit AND l.credit_cents=expected_credit)
     THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM bank_journal_line WHERE entry_id=NEW.id)<>
   (SELECT count(*) FROM bank_merchant_settlement_line WHERE settlement_id=document.id)+(CASE WHEN net=0 THEN 0 ELSE 1 END)
   THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_settlement_journal_guard AFTER INSERT ON bank_journal_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_settlement_journal_guard();
CREATE FUNCTION bank_merchant_setup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF EXISTS(SELECT 1 FROM bank_journal_entry WHERE kind IN ('movement','merchant_receipt','merchant_settlement'))
   THEN RAISE EXCEPTION 'BANKING_RECEIPT_SETUP_FROZEN'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER bank_merchant_setup_guard BEFORE UPDATE OR DELETE ON bank_accounting_setup
 FOR EACH ROW EXECUTE FUNCTION bank_merchant_setup_guard();
`;
