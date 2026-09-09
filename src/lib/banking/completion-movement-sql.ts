import { movementExistingExpenseSql } from "./movement-existing-expense";

/** Deferred V11 contract: a balanced journal must also represent its persisted typed document. */
export const completionMovementSql = `
CREATE FUNCTION bank_completion_movement_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e bank_journal_entry%ROWTYPE; m bank_movement%ROWTYPE; target text; p jsonb; a record; l record;
  bank_list text; destination_list text; bank_snapshot jsonb; allowed text[]; expected_source text;
  amount bigint; allocations integer; proof_count integer; expected_count integer; incoming boolean;
  inflow boolean; original_entry text; live_amount numeric; economic_day text; doc_sha text; doc_version integer;
BEGIN
 IF TG_TABLE_NAME='bank_journal_entry' THEN target:=NEW.id; ELSE target:=NEW.entry_id; END IF;
 SELECT * INTO e FROM bank_journal_entry WHERE id=target;
 IF e.id IS NULL THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
 IF e.kind<>'movement' THEN RETURN NULL; END IF;
 SELECT * INTO m FROM bank_movement WHERE id=e.completion_id AND deleted_at IS NULL;
 p:=m.payload; amount:=(p->>'amount_cents')::bigint; incoming:=e.completion_stage='incoming'; inflow:=m.kind='owner_contribution';
 IF m.id IS NULL OR m.kind IS DISTINCT FROM p->>'kind' OR m.reference IS DISTINCT FROM p->>'reference'
   OR p->>'attested' IS DISTINCT FROM 'true' OR e.completion_stage NOT IN ('outgoing','incoming')
   OR e.amount_cents IS DISTINCT FROM amount OR e.reference IS DISTINCT FROM m.reference
   OR e.description IS DISTINCT FROM p->>'description'
   OR e.source_snapshot->'source'->>'kind' IS DISTINCT FROM 'movement'
   OR e.source_snapshot->'movement'->>'id' IS DISTINCT FROM m.id
   OR (e.source_snapshot->'movement'->>'revision')::integer IS DISTINCT FROM m.revision
   OR ((e.source_snapshot->'movement')-ARRAY['id','revision','created_by','created_at']) IS DISTINCT FROM p
   OR e.source_snapshot->'facts' IS DISTINCT FROM m.source_snapshot
   OR (NOT incoming AND (e.day IS DISTINCT FROM p->>'day' OR e.transaction_id IS DISTINCT FROM p->>'transaction_id'))
   OR (incoming AND m.kind<>'bank_transfer')
   THEN RAISE EXCEPTION 'BANKING_MOVEMENT_CONTRACT_INVALID'; END IF;
 SELECT ba.qb_list_id INTO bank_list FROM bank_account ba JOIN bank_connection c ON c.id=ba.connection_id
   JOIN qb_account q ON q.qb_list_id=ba.qb_list_id WHERE ba.id=p->>'bank_account_id' AND ba.deleted_at IS NULL
   AND ba.is_active AND ba.is_selected AND ba.type='depository' AND ba.currency='USD' AND ba.review_start_date<=p->>'day'
   AND c.environment='sandbox' AND c.deleted_at IS NULL AND q.is_active AND q.deleted_at IS NULL
   AND q.account_type='Bank' AND q.currency IN ('USD','US Dollar');
 IF bank_list IS NULL THEN RAISE EXCEPTION 'BANKING_MOVEMENT_BANK_INVALID'; END IF;
 SELECT sha256,version INTO doc_sha,doc_version FROM bank_evidence_document WHERE id=p->>'evidence_id' AND deleted_at IS NULL;
 IF doc_sha IS NULL OR m.source_snapshot->'evidence' IS DISTINCT FROM jsonb_build_object('sha256',doc_sha,'version',doc_version)
   THEN RAISE EXCEPTION 'BANKING_MOVEMENT_SOURCE_STALE'; END IF;
 SELECT count(*) INTO allocations FROM bank_movement_allocation WHERE movement_id=m.id;
 IF allocations IS DISTINCT FROM jsonb_array_length(p->'allocations') OR allocations>100
   THEN RAISE EXCEPTION 'BANKING_MOVEMENT_CONTRACT_INVALID'; END IF;
 IF m.kind='bank_transfer' THEN
   SELECT ba.qb_list_id INTO destination_list FROM bank_account ba JOIN bank_connection c ON c.id=ba.connection_id
     JOIN qb_account q ON q.qb_list_id=ba.qb_list_id WHERE ba.id=p->>'destination_bank_account_id'
     AND ba.deleted_at IS NULL AND ba.is_active AND ba.is_selected AND ba.type='depository' AND ba.currency='USD'
     AND ba.review_start_date<=e.day AND c.environment='sandbox' AND c.deleted_at IS NULL
     AND q.is_active AND q.deleted_at IS NULL AND q.account_type='Bank' AND q.currency IN ('USD','US Dollar');
   IF allocations<>0 OR destination_list IS NULL OR destination_list=bank_list
     OR NOT EXISTS(SELECT 1 FROM qb_account WHERE qb_list_id=p->>'transit_account_list_id' AND is_active
       AND deleted_at IS NULL AND account_type='OtherCurrentAsset' AND (currency IS NULL OR currency IN ('USD','US Dollar')))
     OR (SELECT count(*) FROM bank_journal_line WHERE entry_id=e.id)<>2
     OR NOT EXISTS(SELECT 1 FROM bank_journal_line WHERE entry_id=e.id AND role='transit'
       AND account_list_id=p->>'transit_account_list_id' AND account_snapshot->>'account_type'='OtherCurrentAsset'
       AND debit_cents=CASE WHEN incoming THEN 0 ELSE amount END AND credit_cents=CASE WHEN incoming THEN amount ELSE 0 END)
     THEN RAISE EXCEPTION 'BANKING_TRANSFER_INVALID'; END IF;
   IF incoming THEN
     SELECT prior_entry.id INTO original_entry FROM bank_journal_entry prior_entry WHERE prior_entry.completion_id=m.id AND prior_entry.kind='movement'
       AND prior_entry.completion_stage='outgoing' AND prior_entry.day<=e.day
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=prior_entry.id);
     IF original_entry IS NULL OR NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id
       AND source_kind='journal_funding' AND source_id=original_entry AND amount_cents=amount AND capacity_cents=amount)
       THEN RAISE EXCEPTION 'BANKING_TRANSFER_OUTGOING_REQUIRED'; END IF;
     expected_count:=1;
   ELSE
     IF NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind='transfer_document'
       AND source_id=bank_list||':'||lower(regexp_replace(btrim(m.reference),'\\s+',' ','g')) AND amount_cents=amount AND capacity_cents=amount)
       OR NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind='document_evidence'
       AND source_id=doc_sha||':'||bank_list||':transfer' AND amount_cents=amount AND capacity_cents=amount)
       THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
     expected_count:=2;
   END IF;
 ELSE
   IF allocations<1 OR incoming OR p->>'destination_bank_account_id' IS NOT NULL OR p->>'transit_account_list_id' IS NOT NULL
     OR (SELECT sum(amount_cents) FROM bank_movement_allocation WHERE movement_id=m.id)<>amount
     THEN RAISE EXCEPTION 'BANKING_MOVEMENT_AMOUNT_INVALID'; END IF;
   allowed:=CASE m.kind WHEN 'obligation_payment' THEN ARRAY['AccountsPayable'] WHEN 'payroll_match' THEN ARRAY['OtherCurrentLiability']
     WHEN 'wire_match' THEN ARRAY['AccountsPayable','OtherCurrentLiability','OtherCurrentAsset']
     WHEN 'refund_match' THEN ARRAY['AccountsReceivable','OtherCurrentLiability'] WHEN 'credit_card_payment' THEN ARRAY['CreditCard']
     WHEN 'loan_payment' THEN ARRAY['LongTermLiability','OtherCurrentLiability']
     WHEN 'owner_contribution' THEN ARRAY['Equity'] WHEN 'owner_withdrawal' THEN ARRAY['Equity']
     WHEN 'advance' THEN ARRAY['OtherCurrentAsset','OtherAsset'] ELSE ARRAY[]::text[] END;
   expected_source:=CASE m.kind WHEN 'obligation_payment' THEN 'vendor_bill' WHEN 'payroll_match' THEN 'payroll'
     WHEN 'wire_match' THEN 'wire' WHEN 'refund_match' THEN 'refund' ELSE 'document' END;
   FOR a IN SELECT * FROM bank_movement_allocation WHERE movement_id=m.id ORDER BY sort_order LOOP
     IF a.payload IS DISTINCT FROM p->'allocations'->a.sort_order OR a.sort_order<0
       OR a.source_kind IS DISTINCT FROM a.payload->>'source_kind' OR a.source_id IS DISTINCT FROM a.payload->>'source_id'
       OR a.amount_cents IS DISTINCT FROM (a.payload->>'amount_cents')::bigint
       OR a.capacity_cents IS NULL OR a.capacity_cents IS DISTINCT FROM (a.payload->>'documented_capacity_cents')::bigint
       OR a.capacity_cents<a.amount_cents OR a.payload->>'documented_as_of' IS NULL OR a.payload->>'documented_as_of'>e.day
       OR NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind=a.source_kind AND source_id=a.source_id
         AND amount_cents=a.amount_cents AND capacity_cents=a.capacity_cents AND source_snapshot=m.source_snapshot->'sources'->a.sort_order)
       THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
     SELECT sha256,version INTO doc_sha,doc_version FROM bank_evidence_document WHERE id=a.payload->>'evidence_id' AND deleted_at IS NULL;
     IF doc_sha IS NULL OR m.source_snapshot->'sources'->a.sort_order->'evidence'
       IS DISTINCT FROM jsonb_build_object('sha256',doc_sha,'version',doc_version)
       THEN RAISE EXCEPTION 'BANKING_MOVEMENT_SOURCE_STALE'; END IF;
     SELECT q.account_type,q.currency INTO l FROM qb_account q WHERE q.qb_list_id=a.payload->>'account_list_id' AND q.is_active AND q.deleted_at IS NULL;
     IF l.account_type IS NULL OR (l.currency IS NOT NULL AND l.currency NOT IN ('USD','US Dollar'))
       OR (a.payload->>'role'='principal' AND (NOT(l.account_type=ANY(allowed))
         OR a.source_kind<>expected_source OR a.payload->>'recognition_owner'<>'existing'))
       OR (a.payload->>'role' IN ('fee','interest') AND (l.account_type NOT IN ('Expense','OtherExpense')
         OR a.source_kind<>'document' OR a.payload->>'recognition_owner'<>'new' OR inflow
         OR (a.payload->>'role'='interest' AND m.kind<>'loan_payment')))
       OR a.payload->>'role' NOT IN ('principal','interest','fee')
       THEN RAISE EXCEPTION 'BANKING_COUNTERPART_ACCOUNT_INVALID'; END IF;
     IF a.payload->>'role'='principal' AND NOT EXISTS(SELECT 1 FROM bank_journal_line WHERE entry_id=e.id
       AND role='counterpart_'||a.sort_order AND account_list_id=a.payload->>'account_list_id'
       AND account_snapshot->>'account_type'=l.account_type
       AND debit_cents=CASE WHEN inflow THEN 0 ELSE a.amount_cents END
       AND credit_cents=CASE WHEN inflow THEN a.amount_cents ELSE 0 END)
       THEN RAISE EXCEPTION 'BANKING_MOVEMENT_CONTRACT_INVALID'; END IF;
     IF a.source_kind='document' THEN
       IF a.payload->>'recognition_owner'='new' AND EXISTS(${movementExistingExpenseSql("a.source_id")})
         THEN RAISE EXCEPTION 'BANKING_MOVEMENT_EXPENSE_ALREADY_RECOGNIZED'; END IF;
       IF a.source_id<>lower(regexp_replace(btrim(a.source_id),'\\s+',' ','g'))
         OR NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind='document_evidence'
           AND source_id=doc_sha||':'||(a.payload->>'account_list_id')||':'||(a.payload->>'role') AND capacity_cents=a.capacity_cents)
         THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
     ELSE
       economic_day:=NULL; live_amount:=NULL;
       IF a.source_kind='vendor_bill' THEN
         SELECT (document_date AT TIME ZONE 'America/New_York')::date::text INTO economic_day FROM vendor_bill
           WHERE id=a.source_id AND deleted_at IS NULL AND status IN ('confirmed','synced') FOR SHARE;
       ELSIF a.source_kind='wire' THEN
         SELECT sent_date::text,wire_amount_cents INTO economic_day,live_amount FROM china_wire_transfer
           WHERE id=a.source_id AND status='confirmed' FOR SHARE;
       ELSIF a.source_kind='refund' THEN
         SELECT COALESCE(cp.metadata->>'refund_txn_date',cp.batch_day),
           CASE WHEN cp.type='refund' THEN cp.amount::numeric ELSE (cp.metadata->>'refund_amount')::numeric END
           INTO economic_day,live_amount FROM customer_payment cp WHERE cp.id=a.source_id AND cp.deleted_at IS NULL
           AND lower(cp.currency)='usd' AND cp.status<>'voided'
           AND (cp.type='refund' OR (cp.status IN ('refunded','partial_refunded') AND cp.metadata->>'refund_amount' ~ '^[0-9]+$')) FOR SHARE;
       ELSIF a.source_kind='payroll' THEN
         SELECT month||'-'||split_part(a.source_id,':',2),CASE WHEN split_part(a.source_id,':',2)='15'
           THEN floor(amount_cents::numeric/2) ELSE amount_cents-floor(amount_cents::numeric/2) END INTO economic_day,live_amount
           FROM pos_monthly_payroll WHERE month=split_part(a.source_id,':',1)
           AND a.source_id IN (month||':15',month||':'||LEAST(30,
             extract(day FROM (month||'-01')::date+interval '1 month'-interval '1 day')::integer)::text) FOR SHARE;
       END IF;
       IF economic_day IS NULL OR economic_day>a.payload->>'documented_as_of'
         THEN RAISE EXCEPTION 'BANKING_MOVEMENT_SOURCE_DATE_INVALID'; END IF;
       IF a.source_kind<>'vendor_bill' AND (live_amount IS NULL OR live_amount<a.capacity_cents OR live_amount<>trunc(live_amount))
         THEN RAISE EXCEPTION 'BANKING_DOCUMENTED_CAPACITY_INVALID'; END IF;
     END IF;
   END LOOP;
   IF NOT EXISTS(SELECT 1 FROM bank_movement_allocation WHERE movement_id=m.id AND payload->>'role'='principal')
     THEN RAISE EXCEPTION 'BANKING_MOVEMENT_CONTRACT_INVALID'; END IF;
   FOR a IN SELECT payload->>'account_list_id' account_id,sum(amount_cents) cents,
     row_number() OVER(ORDER BY min(sort_order))-1 expense_index FROM bank_movement_allocation
     WHERE movement_id=m.id AND payload->>'role' IN ('fee','interest') GROUP BY payload->>'account_list_id' LOOP
     IF NOT EXISTS(SELECT 1 FROM bank_journal_line WHERE entry_id=e.id AND account_list_id=a.account_id
       AND role=CASE WHEN a.expense_index=0 THEN 'expense' ELSE 'expense_'||a.expense_index END
       AND debit_cents=a.cents AND credit_cents=0) THEN RAISE EXCEPTION 'BANKING_MOVEMENT_CONTRACT_INVALID'; END IF;
   END LOOP;
   SELECT count(DISTINCT ev.sha256||':'||(ma.payload->>'account_list_id')||':'||(ma.payload->>'role')) INTO proof_count
     FROM bank_movement_allocation ma JOIN bank_evidence_document ev ON ev.id=ma.payload->>'evidence_id'
     WHERE ma.movement_id=m.id AND ma.source_kind='document';
   FOR a IN SELECT ev.sha256||':'||(ma.payload->>'account_list_id')||':'||(ma.payload->>'role') proof_id,sum(ma.amount_cents) cents
     FROM bank_movement_allocation ma JOIN bank_evidence_document ev ON ev.id=ma.payload->>'evidence_id'
     WHERE ma.movement_id=m.id AND ma.source_kind='document'
     GROUP BY ev.sha256,ma.payload->>'account_list_id',ma.payload->>'role' LOOP
     IF NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind='document_evidence'
       AND source_id=a.proof_id AND amount_cents=a.cents) THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
   END LOOP;
   expected_count:=allocations+proof_count;
   IF (SELECT count(*) FROM bank_journal_line WHERE entry_id=e.id)<>1+
      (SELECT count(*) FROM bank_movement_allocation WHERE movement_id=m.id AND payload->>'role'='principal')+
      (SELECT count(DISTINCT payload->>'account_list_id') FROM bank_movement_allocation WHERE movement_id=m.id AND payload->>'role' IN ('fee','interest'))
     THEN RAISE EXCEPTION 'BANKING_MOVEMENT_CONTRACT_INVALID'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM bank_journal_line WHERE entry_id=e.id AND role='bank'
   AND account_list_id=CASE WHEN incoming THEN destination_list ELSE bank_list END
   AND debit_cents=CASE WHEN incoming OR inflow THEN amount ELSE 0 END
   AND credit_cents=CASE WHEN incoming OR inflow THEN 0 ELSE amount END)
   OR (SELECT count(*) FROM bank_source_claim WHERE entry_id=e.id)<>expected_count+(CASE WHEN e.transaction_id IS NULL THEN 0 ELSE 1 END)
   THEN RAISE EXCEPTION 'BANKING_MOVEMENT_CONTRACT_INVALID'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_completion_movement_entry AFTER INSERT ON bank_journal_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='movement') EXECUTE FUNCTION bank_completion_movement_contract();
CREATE CONSTRAINT TRIGGER bank_completion_movement_line AFTER INSERT ON bank_journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_completion_movement_contract();
CREATE CONSTRAINT TRIGGER bank_completion_movement_claim AFTER INSERT ON bank_source_claim
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_completion_movement_contract();
`;
