/** Additive guards for every legacy/new Bank line and financial evidence mutation. */
export const statementGuardSql = `
CREATE FUNCTION bank_statement_assert_open(account_id text,business_day text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF EXISTS(SELECT 1 FROM bank_statement s WHERE s.account_list_id=account_id AND s.status='closed'
   AND s.deleted_at IS NULL AND business_day BETWEEN s.from_day AND s.to_day)
 THEN RAISE EXCEPTION 'BANKING_STATEMENT_PERIOD_CLOSED'; END IF;
END $$;
CREATE FUNCTION bank_statement_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE statement_id text; parent bank_statement%ROWTYPE; month_day date;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF TG_TABLE_NAME='bank_statement' THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'BANKING_STATEMENT_HISTORY_IMMUTABLE'; END IF;
   IF NEW.status='closed' OR (TG_OP='UPDATE' AND OLD.status='closed') THEN
     FOR month_day IN SELECT generate_series(date_trunc('month',NEW.from_day::date),date_trunc('month',NEW.to_day::date),interval '1 month')::date LOOP
       PERFORM pg_advisory_xact_lock(hashtextextended('accounting-period:'||to_char(month_day,'YYYY-MM'),7242));
       IF EXISTS(SELECT 1 FROM accounting_period_close p WHERE p.status='closed' AND month_day>=p.period_start AND month_day<p.period_end)
       THEN RAISE EXCEPTION 'BANKING_ACCOUNTING_PERIOD_CLOSED'; END IF;
     END LOOP;
   END IF;
   IF TG_OP='UPDATE' AND OLD.status='closed' THEN
     IF NEW.status<>'draft' OR NEW.closed_snapshot IS DISTINCT FROM OLD.closed_snapshot
       OR (to_jsonb(OLD)-ARRAY['status','revision','updated_at','history']) IS DISTINCT FROM
          (to_jsonb(NEW)-ARRAY['status','revision','updated_at','history'])
     THEN RAISE EXCEPTION 'BANKING_STATEMENT_HISTORY_IMMUTABLE'; END IF;
     IF EXISTS(SELECT 1 FROM bank_statement s WHERE s.account_list_id=OLD.account_list_id AND s.from_day>OLD.to_day
       AND s.status='closed') THEN RAISE EXCEPTION 'BANKING_STATEMENT_CLOSED_SUCCESSOR'; END IF;
   END IF;
   IF EXISTS(SELECT 1 FROM bank_statement s WHERE s.account_list_id=NEW.account_list_id AND s.id<>NEW.id
     AND s.deleted_at IS NULL AND s.from_day<=NEW.to_day AND s.to_day>=NEW.from_day)
   THEN RAISE EXCEPTION 'BANKING_STATEMENT_PERIOD_OVERLAP'; END IF;
   RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='bank_statement_match' AND TG_OP='DELETE' THEN RAISE EXCEPTION 'BANKING_STATEMENT_MATCH_IMMUTABLE'; END IF;
 statement_id:=CASE WHEN TG_OP='DELETE' THEN OLD.statement_id ELSE NEW.statement_id END;
 SELECT * INTO parent FROM bank_statement WHERE id=statement_id;
 IF parent.status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'BANKING_STATEMENT_PERIOD_CLOSED'; END IF;
 IF TG_OP='UPDATE' AND OLD.statement_id<>NEW.statement_id THEN RAISE EXCEPTION 'BANKING_STATEMENT_HISTORY_IMMUTABLE'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_document_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_statement
 FOR EACH ROW EXECUTE FUNCTION bank_statement_document_guard();
CREATE TRIGGER bank_statement_line_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_line
 FOR EACH ROW EXECUTE FUNCTION bank_statement_document_guard();
CREATE TRIGGER bank_statement_match_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_statement_match
 FOR EACH ROW EXECUTE FUNCTION bank_statement_document_guard();
CREATE FUNCTION bank_statement_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 SELECT day INTO d FROM bank_journal_entry WHERE id=NEW.entry_id;
 IF NEW.account_snapshot->>'account_type'='Bank' THEN PERFORM bank_statement_assert_open(NEW.account_list_id,d); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_journal_guard BEFORE INSERT ON bank_journal_line
 FOR EACH ROW EXECUTE FUNCTION bank_statement_journal_guard();
CREATE FUNCTION bank_statement_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE txid text; mapped text; d text; previous_mapped text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF TG_TABLE_NAME='bank_account' THEN
   IF TG_OP='UPDATE' AND OLD.qb_list_id IS NOT DISTINCT FROM NEW.qb_list_id AND OLD.currency IS NOT DISTINCT FROM NEW.currency
     AND OLD.type IS NOT DISTINCT FROM NEW.type AND OLD.is_active=NEW.is_active AND OLD.is_selected=NEW.is_selected
     AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at THEN RETURN NEW; END IF;
   IF EXISTS(SELECT 1 FROM bank_statement s WHERE s.account_list_id=OLD.qb_list_id AND s.status='closed')
   THEN RAISE EXCEPTION 'BANKING_STATEMENT_PERIOD_CLOSED'; END IF;
 ELSIF TG_TABLE_NAME='bank_transaction_review' THEN
   txid:=CASE WHEN TG_OP='DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END;
   IF TG_OP='UPDATE' AND OLD.transaction_id IS DISTINCT FROM NEW.transaction_id THEN
     SELECT a.qb_list_id,t.transaction_date INTO mapped,d FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id
       WHERE t.id=OLD.transaction_id;
     PERFORM bank_statement_assert_open(mapped,d);
   END IF;
 ELSIF TG_TABLE_NAME='bank_deposit_line' THEN
   SELECT a.qb_list_id,p.deposit_date INTO mapped,d FROM bank_deposit p JOIN bank_account a ON a.id=p.account_id
     WHERE p.id=CASE WHEN TG_OP='DELETE' THEN OLD.deposit_id ELSE NEW.deposit_id END;
   PERFORM bank_statement_assert_open(mapped,d);
   IF TG_OP='UPDATE' AND OLD.deposit_id IS DISTINCT FROM NEW.deposit_id THEN
     SELECT a.qb_list_id,p.deposit_date INTO mapped,d FROM bank_deposit p JOIN bank_account a ON a.id=p.account_id WHERE p.id=OLD.deposit_id;
     PERFORM bank_statement_assert_open(mapped,d); END IF;
 ELSIF TG_TABLE_NAME='bank_deposit' THEN
   SELECT qb_list_id INTO mapped FROM bank_account WHERE id=OLD.account_id;
   PERFORM bank_statement_assert_open(mapped,OLD.deposit_date);
   IF TG_OP='UPDATE' THEN SELECT qb_list_id INTO mapped FROM bank_account WHERE id=NEW.account_id;
     PERFORM bank_statement_assert_open(mapped,NEW.deposit_date); END IF;
 END IF;
 IF txid IS NOT NULL THEN
   SELECT a.qb_list_id,t.transaction_date INTO mapped,d FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id WHERE t.id=txid;
   PERFORM bank_statement_assert_open(mapped,d);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_account_guard BEFORE UPDATE OR DELETE ON bank_account FOR EACH ROW EXECUTE FUNCTION bank_statement_evidence_guard();
CREATE TRIGGER bank_statement_review_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_transaction_review FOR EACH ROW EXECUTE FUNCTION bank_statement_evidence_guard();
CREATE TRIGGER bank_statement_deposit_guard BEFORE UPDATE OR DELETE ON bank_deposit FOR EACH ROW EXECUTE FUNCTION bank_statement_evidence_guard();
CREATE TRIGGER bank_statement_deposit_line_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_deposit_line FOR EACH ROW EXECUTE FUNCTION bank_statement_evidence_guard();
CREATE FUNCTION bank_statement_historical_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF NEW.kind<>'reversal' AND NEW.transaction_id IS NOT NULL AND EXISTS(SELECT 1 FROM bank_statement_line l
   JOIN bank_statement_match m ON m.statement_line_id=l.id JOIN bank_journal_line jl ON jl.id=m.book_id
   WHERE l.transaction_id=NEW.transaction_id AND l.deleted_at IS NULL AND m.deleted_at IS NULL
     AND m.book_kind='journal_line' AND jl.role LIKE 'uncleared_%')
 THEN RAISE EXCEPTION 'BANKING_STATEMENT_OPENING_TRANSACTION_CLAIMED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_historical_claim_guard BEFORE INSERT ON bank_journal_entry
 FOR EACH ROW EXECUTE FUNCTION bank_statement_historical_claim_guard();
`;
