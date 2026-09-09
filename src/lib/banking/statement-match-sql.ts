export const statementMatchSql = `
CREATE FUNCTION bank_statement_match_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent bank_statement%ROWTYPE; line bank_statement_line%ROWTYPE; cents bigint; mapped text; d text;
 used numeric; clear_transaction text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF TG_OP='UPDATE' THEN
   IF NEW.deleted_at IS NULL OR OLD.deleted_at IS NOT NULL OR length(trim(COALESCE(NEW.removed_reason,'')))<8
     OR NEW.removed_by IS NULL OR (to_jsonb(NEW)-ARRAY['deleted_at','updated_at','removed_by','removed_reason'])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['deleted_at','updated_at','removed_by','removed_reason'])
   THEN RAISE EXCEPTION 'BANKING_STATEMENT_MATCH_IMMUTABLE'; END IF;
   RETURN NEW;
 END IF;
 IF NEW.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'BANKING_STATEMENT_MATCH_INVALID'; END IF;
 SELECT * INTO parent FROM bank_statement WHERE id=NEW.statement_id;
 SELECT * INTO line FROM bank_statement_line WHERE id=NEW.statement_line_id;
 IF parent.status IS DISTINCT FROM 'draft' OR line.statement_id IS DISTINCT FROM parent.id
   OR line.deleted_at IS NOT NULL OR line.source_hash IS DISTINCT FROM NEW.line_hash
 THEN RAISE EXCEPTION 'BANKING_STATEMENT_MATCH_INVALID'; END IF;
 IF NEW.book_kind='journal_line' THEN
   SELECT l.debit_cents-l.credit_cents,l.account_list_id,e.day INTO cents,mapped,d
     FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
     WHERE l.id=NEW.book_id AND l.account_snapshot->>'account_type'='Bank';
 ELSE
   IF line.transaction_id IS NOT NULL AND EXISTS(SELECT 1 FROM bank_transaction_review r
     WHERE r.transaction_id=line.transaction_id AND r.deleted_at IS NULL AND r.status<>'excluded'
       AND (r.matched_payment_id IS NOT NULL OR r.matched_deposit_id IS NOT NULL))
     THEN RAISE EXCEPTION 'BANKING_STATEMENT_OPENING_TRANSACTION_CLAIMED'; END IF;
   IF line.transaction_id IS NOT NULL AND EXISTS(SELECT 1 FROM bank_journal_entry e WHERE e.transaction_id=line.transaction_id
     AND e.kind<>'reversal' AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
     THEN RAISE EXCEPTION 'BANKING_STATEMENT_OPENING_TRANSACTION_CLAIMED'; END IF;
   SELECT (CASE i.kind WHEN 'deposit_in_transit' THEN i.amount_cents ELSE -i.amount_cents END),b.account_list_id,i.original_day
     INTO cents,mapped,d FROM bank_opening_item i JOIN bank_opening_balance b ON b.id=i.opening_id
     WHERE i.id=NEW.book_id AND i.opening_id=parent.opening_id AND b.status='adopted' AND b.kind='bank'
       AND i.kind IN ('deposit_in_transit','outstanding_check');
   SELECT c.transaction_id INTO clear_transaction FROM bank_opening_clear c WHERE c.item_id=NEW.book_id AND c.kind='clear'
     AND NOT EXISTS(SELECT 1 FROM bank_opening_clear u WHERE u.reverses_clear_id=c.id);
   IF clear_transaction IS NOT NULL AND line.transaction_id IS DISTINCT FROM clear_transaction
     THEN RAISE EXCEPTION 'BANKING_STATEMENT_OPENING_CLEAR_CONFLICT'; END IF;
 END IF;
 IF cents IS NULL OR mapped IS DISTINCT FROM parent.account_list_id OR d>parent.to_day
   OR sign(cents)<>sign(line.amount_cents) THEN RAISE EXCEPTION 'BANKING_STATEMENT_MATCH_INVALID'; END IF;
 SELECT COALESCE(SUM(amount_cents),0) INTO used FROM bank_statement_match
   WHERE book_kind=NEW.book_kind AND book_id=NEW.book_id AND deleted_at IS NULL;
 IF used+NEW.amount_cents>abs(cents) THEN RAISE EXCEPTION 'BANKING_STATEMENT_BOOK_OVERCONSUMED'; END IF;
 SELECT COALESCE(SUM(amount_cents),0) INTO used FROM bank_statement_match
   WHERE statement_line_id=NEW.statement_line_id AND deleted_at IS NULL;
 IF used+NEW.amount_cents>abs(line.amount_cents) THEN RAISE EXCEPTION 'BANKING_STATEMENT_LINE_OVERCONSUMED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_statement_match_capacity BEFORE INSERT OR UPDATE ON bank_statement_match
 FOR EACH ROW EXECUTE FUNCTION bank_statement_match_capacity();
CREATE FUNCTION bank_statement_check_close() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bank_statement%ROWTYPE; opening bank_opening_balance%ROWTYPE; previous bank_statement%ROWTYPE;
 n bigint; credits numeric; debits numeric; book numeric; pending numeric;
BEGIN
 SELECT * INTO s FROM bank_statement WHERE id=NEW.id;
 IF NOT FOUND OR s.status<>'closed' THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 SELECT * INTO opening FROM bank_opening_balance WHERE id=s.opening_id;
 SELECT COUNT(*),COALESCE(SUM(amount_cents) FILTER(WHERE amount_cents>0),0),
   COALESCE(-SUM(amount_cents) FILTER(WHERE amount_cents<0),0) INTO n,credits,debits
   FROM bank_statement_line WHERE statement_id=s.id AND deleted_at IS NULL;
 IF s.payload->>'completeness_attested' IS DISTINCT FROM 'true' OR s.closed_by IS NULL OR s.closed_at IS NULL
   OR s.input_hash IS NULL OR s.closed_snapshot IS NULL OR opening.status IS DISTINCT FROM 'adopted'
   OR opening.account_list_id IS DISTINCT FROM s.account_list_id OR opening.book_balance_cents IS NULL
   OR n IS DISTINCT FROM (s.payload->>'declared_line_count')::bigint
   OR credits IS DISTINCT FROM (s.payload->>'declared_credits_cents')::numeric
   OR debits IS DISTINCT FROM (s.payload->>'declared_debits_cents')::numeric
   OR (s.payload->>'opening_balance_cents')::numeric+credits-debits IS DISTINCT FROM (s.payload->>'closing_balance_cents')::numeric
 THEN RAISE EXCEPTION 'BANKING_STATEMENT_INCOMPLETE'; END IF;
 IF EXISTS(SELECT 1 FROM bank_statement_line l WHERE l.statement_id=s.id AND l.deleted_at IS NULL
   AND (l.day<s.from_day OR l.day>s.to_day OR (SELECT COALESCE(SUM(m.amount_cents),0) FROM bank_statement_match m WHERE m.statement_line_id=l.id AND m.deleted_at IS NULL)<>abs(l.amount_cents)
     OR EXISTS(SELECT 1 FROM bank_statement_match m WHERE m.statement_line_id=l.id AND m.deleted_at IS NULL AND m.line_hash<>l.source_hash)))
 THEN RAISE EXCEPTION 'BANKING_STATEMENT_UNMATCHED_LINES'; END IF;
 IF EXISTS(SELECT 1 FROM bank_transaction t JOIN bank_account a ON a.id=t.account_id WHERE a.qb_list_id=s.account_list_id
   AND t.status='posted' AND t.deleted_at IS NULL AND t.transaction_date BETWEEN s.from_day AND s.to_day
   AND NOT EXISTS(SELECT 1 FROM bank_statement_line l WHERE l.statement_id=s.id AND l.transaction_id=t.id AND l.deleted_at IS NULL))
 THEN RAISE EXCEPTION 'BANKING_STATEMENT_FEED_UNREPRESENTED'; END IF;
 IF s.predecessor_id IS NOT NULL THEN
   SELECT * INTO previous FROM bank_statement WHERE id=s.predecessor_id;
   IF previous.status IS DISTINCT FROM 'closed' OR previous.account_list_id<>s.account_list_id
     OR previous.to_day::date+1<>s.from_day::date
     OR previous.payload->>'closing_balance_cents' IS DISTINCT FROM s.payload->>'opening_balance_cents'
   THEN RAISE EXCEPTION 'BANKING_STATEMENT_PREDECESSOR_REQUIRED'; END IF;
 ELSIF s.from_day<>opening.cut_date OR (s.payload->>'opening_balance_cents')::numeric IS DISTINCT FROM opening.statement_balance_cents
 THEN RAISE EXCEPTION 'BANKING_STATEMENT_PREDECESSOR_REQUIRED'; END IF;
 SELECT opening.book_balance_cents+COALESCE(SUM(l.debit_cents-l.credit_cents),0) INTO book
   FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id WHERE l.account_list_id=s.account_list_id
   AND l.account_snapshot->>'account_type'='Bank' AND e.day BETWEEN opening.cut_date AND s.to_day;
 SELECT COALESCE(SUM(item.amount_cents-sign(item.amount_cents)*COALESCE((SELECT SUM(m.amount_cents)
   FROM bank_statement_match m JOIN bank_statement owner ON owner.id=m.statement_id
   WHERE m.book_kind=item.kind AND m.book_id=item.id AND m.deleted_at IS NULL AND owner.to_day<=s.to_day),0)),0)
 INTO pending FROM (
   SELECT 'journal_line' kind,l.id,l.debit_cents-l.credit_cents amount_cents FROM bank_journal_line l
     JOIN bank_journal_entry e ON e.id=l.entry_id WHERE l.account_list_id=s.account_list_id
     AND l.account_snapshot->>'account_type'='Bank' AND e.day BETWEEN opening.cut_date AND s.to_day
   UNION ALL SELECT 'opening_item',i.id,CASE i.kind WHEN 'deposit_in_transit' THEN i.amount_cents ELSE -i.amount_cents END
     FROM bank_opening_item i WHERE i.opening_id=opening.id AND i.kind IN ('deposit_in_transit','outstanding_check')
 ) item;
 IF book-(s.payload->>'closing_balance_cents')::numeric-pending<>0
   OR (s.closed_snapshot->>'book_balance_cents')::numeric IS DISTINCT FROM book
 THEN RAISE EXCEPTION 'BANKING_STATEMENT_DIFFERENCE'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_statement_close_valid AFTER INSERT OR UPDATE ON bank_statement
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_statement_check_close();
`;
