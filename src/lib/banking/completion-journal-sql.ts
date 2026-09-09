/** Keep the historical v8/v9/v10 functions intact. New branches have separate triggers. */
export const completionJournalSql = `
CREATE FUNCTION bank_completion_is_legacy(target text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT completion_id IS NULL FROM bank_journal_entry WHERE id=target),true)
$$;
DROP TRIGGER bank_journal_source_claim ON bank_journal_entry;
CREATE TRIGGER bank_journal_source_claim BEFORE INSERT ON bank_journal_entry FOR EACH ROW
  WHEN (NEW.completion_id IS NULL) EXECUTE FUNCTION bank_journal_claim_source();
DROP TRIGGER bank_journal_entry_balance ON bank_journal_entry;
CREATE CONSTRAINT TRIGGER bank_journal_entry_balance AFTER INSERT ON bank_journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.completion_id IS NULL) EXECUTE FUNCTION bank_journal_check_balance();
DROP TRIGGER bank_journal_line_balance ON bank_journal_line;
CREATE CONSTRAINT TRIGGER bank_journal_line_balance AFTER INSERT ON bank_journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (bank_completion_is_legacy(NEW.entry_id)) EXECUTE FUNCTION bank_journal_check_balance();
CREATE FUNCTION bank_completion_journal_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original bank_journal_entry%ROWTYPE; existing_entry text; source text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF NEW.kind='reversal' THEN
   SELECT * INTO original FROM bank_journal_entry WHERE id=NEW.reverses_entry_id;
   IF original.kind NOT IN ('movement','merchant_settlement','merchant_receipt') OR original.id IS NULL
     OR original.completion_id IS DISTINCT FROM NEW.completion_id OR original.completion_stage IS DISTINCT FROM NEW.completion_stage
     OR original.transaction_id IS DISTINCT FROM NEW.transaction_id OR original.amount_cents<>NEW.amount_cents
     OR original.source_snapshot<>NEW.source_snapshot OR original.source_hash<>NEW.source_hash OR NEW.day<original.day
     THEN RAISE EXCEPTION 'BANKING_REVERSAL_INVALID'; END IF;
   IF EXISTS(SELECT 1 FROM bank_source_claim own JOIN bank_source_claim dependent ON
       (own.source_kind='payment_recognition' AND dependent.source_kind='payment_funding' AND dependent.source_id=own.source_id)
       OR (dependent.source_kind='journal_funding' AND dependent.source_id=NEW.reverses_entry_id)
       OR (dependent.source_kind='reserve_lot' AND split_part(dependent.source_id,':',1)=NEW.reverses_entry_id)
       WHERE own.entry_id=NEW.reverses_entry_id AND dependent.entry_id<>own.entry_id
         AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=dependent.entry_id))
     THEN RAISE EXCEPTION 'BANKING_RECEIPT_CONSUMED'; END IF;
 ELSE
   IF NEW.kind='movement' AND NOT EXISTS(SELECT 1 FROM bank_movement WHERE id=NEW.completion_id AND deleted_at IS NULL)
     THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
   IF NEW.source_snapshot->'source'->>'id' IS DISTINCT FROM NEW.completion_id
     OR jsonb_typeof(NEW.source_snapshot->'completion_lines') IS DISTINCT FROM 'array'
     OR jsonb_typeof(NEW.source_snapshot->'completion_claims') IS DISTINCT FROM 'array'
     THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
   SELECT e.id INTO existing_entry FROM bank_journal_entry e WHERE e.completion_id=NEW.completion_id
     AND e.completion_stage=NEW.completion_stage AND e.kind=NEW.kind
     AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id) LIMIT 1;
   IF existing_entry IS NOT NULL THEN RAISE EXCEPTION 'BANKING_ALREADY_POSTED'; END IF;
   IF NEW.transaction_id IS NOT NULL AND EXISTS(SELECT 1 FROM bank_journal_entry e WHERE e.transaction_id=NEW.transaction_id
     AND e.kind<>'reversal' AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
     THEN RAISE EXCEPTION 'BANKING_ALREADY_POSTED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_completion_journal_source BEFORE INSERT ON bank_journal_entry FOR EACH ROW
  WHEN (NEW.completion_id IS NOT NULL) EXECUTE FUNCTION bank_completion_journal_source();
CREATE FUNCTION bank_completion_journal_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e bank_journal_entry%ROWTYPE; target text; n integer; deb numeric; cred numeric; expected jsonb; claim jsonb;
BEGIN
 IF TG_TABLE_NAME='bank_journal_entry' THEN target:=NEW.id; ELSE target:=NEW.entry_id; END IF;
 SELECT * INTO e FROM bank_journal_entry WHERE id=target;
 IF e.id IS NULL THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
 IF e.completion_id IS NULL THEN RETURN NULL; END IF;
 SELECT count(*),coalesce(sum(debit_cents),0),coalesce(sum(credit_cents),0) INTO n,deb,cred FROM bank_journal_line WHERE entry_id=target;
 IF n<2 OR n>102 OR deb<>cred OR deb<>e.amount_cents OR jsonb_array_length(e.source_snapshot->'completion_lines')<>n
   THEN RAISE EXCEPTION 'BANKING_JOURNAL_UNBALANCED'; END IF;
 IF EXISTS(SELECT 1 FROM bank_journal_line l WHERE l.entry_id=target AND (
   l.account_snapshot->>'id' IS DISTINCT FROM l.account_list_id OR l.account_snapshot->>'currency' IS DISTINCT FROM 'USD'
   OR (l.role ~ '^expense(_[0-9]+)?$' AND coalesce(l.account_snapshot->>'account_type','') NOT IN ('Expense','OtherExpense'))
   OR (l.role !~ '^expense(_[0-9]+)?$' AND coalesce(l.account_snapshot->>'account_type','') NOT IN
     ('Bank','AccountsReceivable','AccountsPayable','CreditCard','OtherCurrentAsset','OtherAsset','FixedAsset','OtherCurrentLiability','LongTermLiability','Equity'))
   OR ((l.account_snapshot->>'account_type'='Bank') IS DISTINCT FROM (l.role ~ '^bank(_[0-9]+)?$'))))
   THEN RAISE EXCEPTION 'BANKING_COUNTERPART_ACCOUNT_INVALID'; END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements(e.source_snapshot->'completion_lines') LOOP
   IF NOT EXISTS(SELECT 1 FROM bank_journal_line l WHERE l.entry_id=target AND l.role=expected->>'role'
     AND l.account_list_id=expected->>'account_list_id' AND l.account_snapshot=expected->'account_snapshot'
     AND l.debit_cents=(CASE WHEN e.kind='reversal' THEN expected->>'credit_cents' ELSE expected->>'debit_cents' END)::bigint
     AND l.credit_cents=(CASE WHEN e.kind='reversal' THEN expected->>'debit_cents' ELSE expected->>'credit_cents' END)::bigint)
     THEN RAISE EXCEPTION 'BANKING_JOURNAL_UNBALANCED'; END IF;
 END LOOP;
 IF e.kind='reversal' THEN
   IF EXISTS(SELECT 1 FROM bank_journal_line l FULL JOIN bank_journal_line prior_line ON prior_line.entry_id=e.reverses_entry_id AND prior_line.role=l.role
     WHERE l.entry_id=target AND (prior_line.id IS NULL OR l.account_list_id<>prior_line.account_list_id OR l.account_snapshot<>prior_line.account_snapshot
       OR l.debit_cents<>prior_line.credit_cents OR l.credit_cents<>prior_line.debit_cents))
     THEN RAISE EXCEPTION 'BANKING_REVERSAL_INVALID'; END IF;
 ELSE
   IF jsonb_array_length(e.source_snapshot->'completion_claims')<>(SELECT count(*) FROM bank_source_claim WHERE entry_id=target)
     OR NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=target)
     THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
   FOR claim IN SELECT value FROM jsonb_array_elements(e.source_snapshot->'completion_claims') LOOP
     IF NOT EXISTS(SELECT 1 FROM bank_source_claim c WHERE c.entry_id=target AND c.source_kind=claim->>'source_kind'
       AND c.source_id=claim->>'source_id' AND c.amount_cents=(claim->>'amount_cents')::bigint
       AND c.capacity_cents=(claim->>'capacity_cents')::bigint AND c.source_hash=claim->>'source_hash' AND c.source_snapshot=claim->'source_snapshot')
       THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
   END LOOP;
   IF e.transaction_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=target
     AND source_kind='transaction' AND source_id=e.transaction_id) OR NOT EXISTS(
       SELECT 1 FROM bank_journal_line l JOIN bank_transaction t ON t.id=e.transaction_id JOIN bank_account a ON a.id=t.account_id
       WHERE l.entry_id=target AND l.role='bank' AND l.account_list_id=a.qb_list_id
         AND l.credit_cents-l.debit_cents=t.amount::numeric*100))
     THEN RAISE EXCEPTION 'BANKING_TRANSACTION_AMOUNT_INVALID'; END IF;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_completion_entry_balance AFTER INSERT ON bank_journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.completion_id IS NOT NULL) EXECUTE FUNCTION bank_completion_journal_balance();
CREATE CONSTRAINT TRIGGER bank_completion_line_balance AFTER INSERT ON bank_journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_completion_journal_balance();
CREATE CONSTRAINT TRIGGER bank_completion_claim_balance AFTER INSERT ON bank_source_claim
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_completion_journal_balance();
`;
