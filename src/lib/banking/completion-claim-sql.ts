import { paymentReservedCentsSql } from "./payment-evidence";

/** Independent additional guards; v10 trigger bodies remain untouched. */
export const completionClaimSql = `
CREATE FUNCTION bank_completion_legacy_reserved(sk text,sid text) RETURNS numeric LANGUAGE plpgsql STABLE AS $$
DECLARE reserved numeric;
BEGIN
 IF sk='transaction' THEN
   IF EXISTS(SELECT 1 FROM bank_journal_entry e WHERE e.transaction_id=sid AND e.completion_id IS NULL AND e.kind<>'reversal'
     AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
     OR EXISTS(SELECT 1 FROM bank_opening_clear c WHERE c.transaction_id=sid AND c.kind='clear'
       AND NOT EXISTS(SELECT 1 FROM bank_opening_clear u WHERE u.reverses_clear_id=c.id))
     OR EXISTS(SELECT 1 FROM bank_transaction_review r WHERE r.transaction_id=sid AND r.deleted_at IS NULL AND r.status<>'excluded'
       AND (r.matched_payment_id IS NOT NULL OR r.matched_deposit_id IS NOT NULL))
   THEN RETURN 1000000000000; END IF;
 ELSIF sk='payment_recognition' THEN
   IF EXISTS(SELECT 1 FROM bank_receipt_accounting a JOIN bank_journal_entry e ON e.receipt_id=a.id WHERE a.payment_id=sid
     AND e.kind='receipt' AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id))
     OR EXISTS(SELECT 1 FROM bank_opening_item oi JOIN bank_opening_balance b ON b.id=oi.opening_id WHERE oi.payment_id=sid AND b.status='adopted')
   THEN RETURN 1000000000000; END IF;
 ELSIF sk='payment_funding' THEN
   SELECT ${paymentReservedCentsSql()} INTO reserved FROM customer_payment mp WHERE mp.id=sid;
   RETURN COALESCE(reserved,0);
 ELSIF sk='opening_funding' THEN RETURN bank_opening_reserved(sid,NULL);
 END IF;
 RETURN 0;
END $$;
CREATE FUNCTION bank_completion_active_claims(sk text,sid text,excluded text DEFAULT NULL) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT COALESCE(SUM(c.amount_cents),0) FROM bank_source_claim c WHERE c.source_kind=sk AND c.source_id=sid
   AND c.entry_id IS DISTINCT FROM excluded AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=c.entry_id)
$$;
CREATE FUNCTION bank_completion_validate_claim(sk text,sid text,cents bigint,capacity bigint,hash text,owner_entry text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE pinned bank_source_claim%ROWTYPE; live_amount numeric; recognized numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF sk !~ '^[a-z][a-z0-9_]{0,63}$' OR length(trim(sid))=0 OR cents<=0 OR capacity<cents OR capacity>999999999999
   THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
 SELECT * INTO pinned FROM bank_source_claim WHERE source_kind=sk AND source_id=sid ORDER BY created_at,id LIMIT 1;
 IF pinned.id IS NOT NULL AND (pinned.capacity_cents<>capacity OR pinned.source_hash<>hash)
   THEN RAISE EXCEPTION 'BANKING_SOURCE_CAPACITY_STALE'; END IF;
 IF sk='transaction' THEN
   SELECT abs(amount::numeric)*100 INTO live_amount FROM bank_transaction WHERE id=sid AND status='posted' AND deleted_at IS NULL AND currency='USD';
   IF live_amount IS DISTINCT FROM cents::numeric OR capacity<>cents THEN RAISE EXCEPTION 'BANKING_TRANSACTION_AMOUNT_INVALID'; END IF;
 ELSIF sk IN ('payment_recognition','payment_funding') THEN
   SELECT amount::numeric INTO live_amount FROM customer_payment WHERE id=sid AND deleted_at IS NULL AND type='payment'
     AND lower(currency)='usd' AND status IN ('available','partially_applied','applied') FOR SHARE;
   IF live_amount IS NULL OR live_amount<>capacity OR (sk='payment_recognition' AND cents<>capacity)
     THEN RAISE EXCEPTION 'BANKING_RECEIPT_SOURCE_DRIFT'; END IF;
   IF sk='payment_funding' THEN
     SELECT COALESCE(SUM(c.amount_cents),0) INTO recognized FROM bank_source_claim c WHERE c.source_kind='payment_recognition' AND c.source_id=sid
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=c.entry_id);
     IF recognized=0 THEN SELECT COALESCE(SUM(e.amount_cents),0) INTO recognized FROM bank_receipt_accounting a
       JOIN bank_journal_entry e ON e.receipt_id=a.id WHERE a.payment_id=sid AND e.kind='receipt'
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id); END IF;
     IF recognized<>capacity THEN RAISE EXCEPTION 'BANKING_RECEIPT_POSTING_REQUIRED'; END IF;
   END IF;
 ELSIF sk='opening_funding' THEN
   SELECT i.amount_cents INTO live_amount FROM bank_opening_item i JOIN bank_opening_balance b ON b.id=i.opening_id
     WHERE i.id=sid AND b.status='adopted' AND i.kind='uf_receipt';
   IF live_amount IS DISTINCT FROM capacity::numeric THEN RAISE EXCEPTION 'BANKING_OPENING_CONSUMPTION_INVALID'; END IF;
 ELSIF sk='journal_funding' THEN
   SELECT e.amount_cents INTO live_amount FROM bank_journal_entry e WHERE e.id=sid AND e.kind<>'reversal'
     AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id);
   IF live_amount IS NULL OR capacity>live_amount THEN RAISE EXCEPTION 'BANKING_RECEIPT_POSTING_REQUIRED'; END IF;
 ELSIF sk='reserve_lot' THEN
   IF sid IS DISTINCT FROM split_part(sid,':',1)||':'||split_part(sid,':',2)
     OR split_part(sid,':',2) !~ '^counterpart_[0-9]+$' THEN RAISE EXCEPTION 'BANKING_RESERVE_LOT_INVALID'; END IF;
   SELECT l.debit_cents INTO live_amount FROM bank_journal_line l JOIN bank_journal_entry e ON e.id=l.entry_id
     WHERE e.id=split_part(sid,':',1) AND l.role=split_part(sid,':',2) AND e.kind='merchant_settlement'
       AND l.account_snapshot->>'account_type'='OtherCurrentAsset' AND l.account_snapshot->>'currency'='USD'
       AND l.debit_cents>0 AND l.credit_cents=0
       AND e.source_snapshot->'settlement'->'lines'->(substring(split_part(sid,':',2) from '^counterpart_([0-9]+)$')::integer)->>'kind'='reserve_hold'
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=e.id);
   IF live_amount IS NULL OR capacity<>live_amount THEN RAISE EXCEPTION 'BANKING_RESERVE_LOT_INVALID'; END IF;
 END IF;
 IF bank_completion_active_claims(sk,sid,owner_entry)+bank_completion_legacy_reserved(sk,sid)+cents>capacity
   THEN RAISE EXCEPTION 'BANKING_SOURCE_OVERCONSUMED'; END IF;
END $$;
CREATE FUNCTION bank_completion_claim_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e bank_journal_entry%ROWTYPE;
BEGIN
 SELECT * INTO e FROM bank_journal_entry WHERE id=NEW.entry_id;
 IF e.completion_id IS NULL OR e.kind='reversal' THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
 PERFORM bank_completion_validate_claim(NEW.source_kind,NEW.source_id,NEW.amount_cents,NEW.capacity_cents,NEW.source_hash,NEW.entry_id);
 RETURN NEW;
END $$;
CREATE TRIGGER bank_completion_claim_insert BEFORE INSERT ON bank_source_claim FOR EACH ROW EXECUTE FUNCTION bank_completion_claim_insert();
CREATE FUNCTION bank_completion_legacy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment_id text; active numeric; monetary numeric; original bank_journal_entry%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
 IF TG_TABLE_NAME='bank_journal_entry' THEN
   IF NEW.kind='reversal' THEN
     SELECT * INTO original FROM bank_journal_entry WHERE id=NEW.reverses_entry_id;
     IF original.kind='receipt' THEN
       SELECT a.payment_id INTO payment_id FROM bank_receipt_accounting a WHERE a.id=original.receipt_id;
       IF bank_completion_active_claims('payment_funding',payment_id)>0 THEN RAISE EXCEPTION 'BANKING_RECEIPT_CONSUMED'; END IF;
     END IF;
     RETURN NEW;
   END IF;
   IF NEW.completion_id IS NULL AND NEW.transaction_id IS NOT NULL AND bank_completion_active_claims('transaction',NEW.transaction_id)>0
     THEN RAISE EXCEPTION 'BANKING_SOURCE_OVERCONSUMED'; END IF;
   IF NEW.kind='receipt' THEN
     SELECT a.payment_id INTO payment_id FROM bank_receipt_accounting a WHERE a.id=NEW.receipt_id;
     IF bank_completion_active_claims('payment_recognition',payment_id)>0 THEN RAISE EXCEPTION 'BANKING_ALREADY_POSTED'; END IF;
   END IF;
 ELSIF TG_TABLE_NAME='bank_opening_clear' THEN
   IF NEW.kind='clear' AND bank_completion_active_claims('transaction',NEW.transaction_id)>0
     THEN RAISE EXCEPTION 'BANKING_OPENING_TRANSACTION_CLAIMED'; END IF;
 ELSIF TG_TABLE_NAME='bank_opening_balance' THEN
   IF NEW.status='adopted' AND EXISTS(SELECT 1 FROM bank_opening_item i WHERE i.opening_id=NEW.id AND i.payment_id IS NOT NULL
     AND (bank_completion_active_claims('payment_recognition',i.payment_id)>0 OR bank_completion_active_claims('payment_funding',i.payment_id)>0))
     THEN RAISE EXCEPTION 'BANKING_OPENING_SOURCE_ALREADY_CLAIMED'; END IF;
 ELSIF TG_TABLE_NAME='bank_deposit_line' THEN
   IF NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
   payment_id:=NEW.payment_id;
   IF NEW.opening_item_id IS NOT NULL THEN
     SELECT amount_cents INTO monetary FROM bank_opening_item WHERE id=NEW.opening_item_id;
     IF bank_completion_active_claims('opening_funding',NEW.opening_item_id)+bank_opening_reserved(NEW.opening_item_id,NULL)>monetary
       THEN RAISE EXCEPTION 'BANKING_SOURCE_OVERCONSUMED'; END IF;
   END IF;
 ELSIF TG_TABLE_NAME='bank_transaction_review' THEN
   IF NEW.deleted_at IS NOT NULL OR NEW.status='excluded' THEN RETURN NEW; END IF;
   IF (NEW.matched_payment_id IS NOT NULL OR NEW.matched_deposit_id IS NOT NULL)
     AND bank_completion_active_claims('transaction',NEW.transaction_id)>0 THEN RAISE EXCEPTION 'BANKING_SOURCE_OVERCONSUMED'; END IF;
   payment_id:=NEW.matched_payment_id;
 ELSIF TG_TABLE_NAME='bank_receipt_consumption' THEN payment_id:=NEW.payment_id;
   IF NEW.opening_item_id IS NOT NULL THEN
     SELECT amount_cents INTO monetary FROM bank_opening_item WHERE id=NEW.opening_item_id;
     IF bank_completion_active_claims('opening_funding',NEW.opening_item_id)+bank_opening_reserved(NEW.opening_item_id,NULL)>monetary
       THEN RAISE EXCEPTION 'BANKING_SOURCE_OVERCONSUMED'; END IF;
   END IF;
 END IF;
 IF payment_id IS NOT NULL THEN
   active:=bank_completion_active_claims('payment_funding',payment_id);
   SELECT amount::numeric INTO monetary FROM customer_payment WHERE id=payment_id;
   IF active>0 AND (monetary IS NULL OR active+bank_completion_legacy_reserved('payment_funding',payment_id)>monetary)
     THEN RAISE EXCEPTION 'BANKING_SOURCE_OVERCONSUMED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bank_completion_legacy_journal BEFORE INSERT ON bank_journal_entry FOR EACH ROW EXECUTE FUNCTION bank_completion_legacy_guard();
CREATE TRIGGER bank_completion_legacy_opening BEFORE INSERT ON bank_opening_clear FOR EACH ROW EXECUTE FUNCTION bank_completion_legacy_guard();
CREATE TRIGGER bank_completion_legacy_adopt BEFORE INSERT OR UPDATE ON bank_opening_balance FOR EACH ROW EXECUTE FUNCTION bank_completion_legacy_guard();
CREATE TRIGGER bank_completion_legacy_deposit AFTER INSERT OR UPDATE ON bank_deposit_line FOR EACH ROW EXECUTE FUNCTION bank_completion_legacy_guard();
CREATE TRIGGER bank_completion_legacy_review AFTER INSERT OR UPDATE ON bank_transaction_review FOR EACH ROW EXECUTE FUNCTION bank_completion_legacy_guard();
CREATE TRIGGER bank_completion_legacy_consumption AFTER INSERT ON bank_receipt_consumption FOR EACH ROW EXECUTE FUNCTION bank_completion_legacy_guard();
`;
