import { movementExistingExpenseSql } from "./movement-existing-expense";
import { bankingEnvSql } from "./security";

/** V12 SQL independently verifies the economic source and each typed settlement allocation. */
export const completionMerchantSql = `
CREATE FUNCTION bank_completion_card_fact(payment_id text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p customer_payment%ROWTYPE; m jsonb; q jsonb;
BEGIN
 SELECT cp.* INTO p FROM customer_payment cp JOIN customer c ON c.id=cp.customer_id AND c.deleted_at IS NULL
   WHERE cp.id=payment_id FOR SHARE OF cp,c;
 m:=COALESCE(p.metadata,'{}'); q:=COALESCE(p.qb,'{}');
 IF p.id IS NULL OR p.deleted_at IS NOT NULL OR p.source<>'pos' OR p.type<>'payment'
   OR p.method NOT IN ('credit_card','debit_card','card') OR p.status NOT IN ('available','partially_applied','applied')
   OR upper(p.currency)<>'USD' OR p.amount::numeric<=0 OR p.amount::numeric<>trunc(p.amount::numeric)
   OR p.amount::numeric>999999999999 OR p.medusa_refund_id IS NOT NULL
   OR COALESCE(m->>'qb_source','') NOT IN ('','receive_payment','customer_payment')
   OR COALESCE(q->>'source','') NOT IN ('','receive_payment','customer_payment')
   OR m->'is_sales_receipt_payment'='true'::jsonb OR m->>'qb_sync_status'='pending_sr'
   OR m->>'qb_import'='true' OR m->'terminal_refunded'='true'::jsonb
   OR COALESCE(m->>'refund_amount','0') !~ '^0([.]0+)?$'
   OR NOT EXISTS(SELECT 1 FROM bank_accounting_setup WHERE id='local-usd' AND deleted_at IS NULL AND cut_date<=p.batch_day)
   THEN RAISE EXCEPTION 'BANKING_RECEIPT_PROVENANCE_UNSUPPORTED'; END IF;
 RETURN jsonb_build_object('fingerprint_version',1,'id',p.id,'customer_id',p.customer_id,'source',p.source,'type',p.type,
   'amount',(p.amount::numeric)::bigint::text,'currency',upper(p.currency),'method',p.method,'status','available',
   'batch_day',p.batch_day,'received_at',to_char(p.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'reference',p.reference,'deleted',false,'customer_deleted',false,'medusa_refund_id',p.medusa_refund_id,
   'provenance',jsonb_build_object('qb_source',m->'qb_source','is_sales_receipt_payment',m->'is_sales_receipt_payment',
     'pending_sr',COALESCE(m->>'qb_sync_status'='pending_sr',false),'qb_import',m->'qb_import','qb_source_kind',q->'source',
     'refund_amount',m->'refund_amount','terminal_refunded',m->'terminal_refunded'));
END $$;
CREATE FUNCTION bank_completion_merchant_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e bank_journal_entry%ROWTYPE; d bank_merchant_settlement%ROWTYPE; target text; payload jsonb; fact jsonb; live jsonb;
 a record; q record; amount numeric; net numeric; total_lines integer; proof_count integer; expected_claims integer;
 bank_list text; evidence_hash text; evidence_version integer; identity jsonb; role_name text; expected_source text;
 origin bank_journal_entry%ROWTYPE; capacity numeric; source_date text; matched_claim boolean;
BEGIN
 IF TG_TABLE_NAME='bank_journal_entry' THEN target:=NEW.id; ELSE target:=NEW.entry_id; END IF;
 SELECT * INTO e FROM bank_journal_entry WHERE id=target;
 IF e.id IS NULL THEN RAISE EXCEPTION 'BANKING_JOURNAL_SOURCE_INVALID'; END IF;
 IF e.kind NOT IN ('merchant_receipt','merchant_settlement') THEN RETURN NULL; END IF;
 IF e.kind='merchant_receipt' THEN
   payload:=e.source_snapshot->'request'; fact:=e.source_snapshot->'fact'; live:=bank_completion_card_fact(e.completion_id);
   IF e.completion_stage<>'recognize' OR e.transaction_id IS NOT NULL OR payload->>'attested' IS DISTINCT FROM 'true'
     OR payload->>'payment_id' IS DISTINCT FROM e.completion_id OR payload->>'day' IS DISTINCT FROM e.day
     OR live->>'batch_day' IS DISTINCT FROM e.day OR (live->>'amount')::bigint IS DISTINCT FROM e.amount_cents
     OR e.source_snapshot->'source'->>'kind' IS DISTINCT FROM 'merchant_receipt' OR fact->'payment' IS DISTINCT FROM live
     OR (SELECT count(*) FROM bank_journal_line WHERE entry_id=e.id)<>2
     OR (SELECT count(*) FROM bank_source_claim WHERE entry_id=e.id)<>1
     OR NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind='payment_recognition'
       AND source_id=e.completion_id AND amount_cents=e.amount_cents AND capacity_cents=e.amount_cents AND source_snapshot=fact)
     THEN RAISE EXCEPTION 'BANKING_MERCHANT_RECEIPT_CONTRACT_INVALID'; END IF;
   SELECT sha256,version INTO evidence_hash,evidence_version FROM bank_evidence_document
     WHERE id=payload->>'evidence_id' AND deleted_at IS NULL;
   IF evidence_hash IS NULL OR fact->'evidence' IS DISTINCT FROM jsonb_build_object('sha256',evidence_hash,'version',evidence_version)
     THEN RAISE EXCEPTION 'BANKING_MERCHANT_RECEIPT_CONTRACT_INVALID'; END IF;
   FOR a IN SELECT * FROM bank_journal_line WHERE entry_id=e.id LOOP
     SELECT account_type,currency INTO q FROM qb_account WHERE qb_list_id=a.account_list_id AND is_active AND deleted_at IS NULL;
     IF q.account_type IS NULL OR (q.currency IS NOT NULL AND q.currency NOT IN ('USD','US Dollar'))
       OR a.account_snapshot IS DISTINCT FROM (CASE WHEN a.role='clearing' THEN fact->'account' ELSE fact->'ar' END)
       OR (a.role='clearing' AND (q.account_type<>'OtherCurrentAsset' OR a.account_list_id IS DISTINCT FROM payload->>'clearing_account_list_id'
         OR a.debit_cents<>e.amount_cents OR a.credit_cents<>0))
       OR (a.role='receivable' AND (q.account_type<>'AccountsReceivable' OR a.account_list_id IS DISTINCT FROM payload->>'ar_account_list_id'
         OR a.debit_cents<>0 OR a.credit_cents<>e.amount_cents)) OR a.role NOT IN ('clearing','receivable')
       OR a.account_snapshot->>'account_type' IS DISTINCT FROM q.account_type
       THEN RAISE EXCEPTION 'BANKING_MERCHANT_RECEIPT_CONTRACT_INVALID'; END IF;
   END LOOP;
   RETURN NULL;
 END IF;
 SELECT * INTO d FROM bank_merchant_settlement WHERE id=e.completion_id AND deleted_at IS NULL;
 payload:=d.payload;
 IF d.id IS NULL OR payload->>'attested' IS DISTINCT FROM 'true' OR e.completion_stage<>'settle'
   OR e.source_snapshot->'source'->>'kind' IS DISTINCT FROM 'merchant_settlement'
   OR e.source_snapshot->'facts' IS DISTINCT FROM d.source_snapshot
   OR (e.source_snapshot->'settlement'->>'revision')::integer IS DISTINCT FROM d.revision
   OR d.processor IS DISTINCT FROM payload->>'processor' OR d.merchant IS DISTINCT FROM payload->>'merchant'
   OR d.reference IS DISTINCT FROM payload->>'reference' OR e.reference IS DISTINCT FROM d.reference
   OR e.transaction_id IS DISTINCT FROM payload->>'transaction_id'
   THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
 SELECT count(*),sum(amount_cents*CASE WHEN kind IN ('receipt','reserve_release') THEN 1 ELSE -1 END)
   INTO total_lines,net FROM bank_merchant_settlement_line WHERE settlement_id=d.id;
 IF total_lines<1 OR total_lines>100 OR total_lines IS DISTINCT FROM jsonb_array_length(payload->'lines')
   THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
 SELECT ba.qb_list_id INTO bank_list FROM bank_account ba JOIN bank_connection c ON c.id=ba.connection_id
   JOIN qb_account qb ON qb.qb_list_id=ba.qb_list_id WHERE ba.id=payload->>'bank_account_id' AND ba.deleted_at IS NULL
   AND ba.is_active AND ba.is_selected AND ba.type='depository' AND ba.currency='USD' AND ba.review_start_date<=e.day
   AND c.environment=${bankingEnvSql()} AND c.deleted_at IS NULL AND qb.is_active AND qb.deleted_at IS NULL
   AND qb.account_type='Bank' AND qb.currency IN ('USD','US Dollar');
 IF bank_list IS NULL OR (net<>0 AND NOT EXISTS(SELECT 1 FROM bank_journal_line WHERE entry_id=e.id AND role='bank'
   AND account_list_id=bank_list AND debit_cents=GREATEST(net,0) AND credit_cents=GREATEST(-net,0)))
   THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_BANK_EVIDENCE_REQUIRED'; END IF;
 SELECT sha256,version INTO evidence_hash,evidence_version FROM bank_evidence_document WHERE id=payload->>'evidence_id' AND deleted_at IS NULL;
 IF evidence_hash IS NULL OR d.source_snapshot->'evidence' IS DISTINCT FROM jsonb_build_object('sha256',evidence_hash,'version',evidence_version)
   THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
 FOR a IN SELECT * FROM bank_merchant_settlement_line WHERE settlement_id=d.id ORDER BY sort_order LOOP
   identity:=d.source_snapshot->'sources'->a.sort_order->'identity';
   IF a.kind IS DISTINCT FROM a.payload->>'kind' OR a.source_id IS DISTINCT FROM a.payload->>'source_id'
     OR a.amount_cents IS DISTINCT FROM (a.payload->>'amount_cents')::bigint
     OR a.payload->>'documented_as_of' IS NULL OR a.payload->>'documented_as_of'>e.day
     OR (a.payload->>'documented_capacity_cents')::bigint IS NULL OR (a.payload->>'documented_capacity_cents')::bigint<a.amount_cents
     OR a.payload->>'recognition_owner' IS DISTINCT FROM (CASE WHEN a.kind IN ('fee','reserve_hold') THEN 'new' ELSE 'existing' END)
     OR (a.kind<>'receipt' AND (a.payload->>'surcharge_cents')::bigint<>0)
     THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
   SELECT account_type,currency INTO q FROM qb_account WHERE qb_list_id=a.payload->>'account_list_id' AND is_active AND deleted_at IS NULL;
   role_name:=(CASE WHEN a.kind='fee' THEN 'expense_' ELSE 'counterpart_' END)||a.sort_order;
   IF q.account_type IS NULL OR (q.currency IS NOT NULL AND q.currency NOT IN ('USD','US Dollar'))
     OR (a.kind='fee' AND q.account_type NOT IN ('Expense','OtherExpense'))
     OR (a.kind IN ('refund','chargeback') AND q.account_type NOT IN ('OtherCurrentLiability','AccountsPayable'))
     OR (a.kind IN ('receipt','reserve_hold','reserve_release') AND q.account_type<>'OtherCurrentAsset')
     OR NOT EXISTS(SELECT 1 FROM bank_journal_line WHERE entry_id=e.id AND role=role_name AND account_snapshot->>'account_type'=q.account_type)
     THEN RAISE EXCEPTION 'BANKING_COUNTERPART_ACCOUNT_INVALID'; END IF;
   SELECT sha256,version INTO evidence_hash,evidence_version FROM bank_evidence_document WHERE id=a.payload->>'evidence_id' AND deleted_at IS NULL;
   IF evidence_hash IS NULL OR d.source_snapshot->'sources'->a.sort_order->'evidence'
     IS DISTINCT FROM jsonb_build_object('sha256',evidence_hash,'version',evidence_version)
     THEN RAISE EXCEPTION 'BANKING_SETTLEMENT_SOURCE_INVALID'; END IF;
   expected_source:=CASE a.kind WHEN 'receipt' THEN 'payment_funding' WHEN 'refund' THEN 'refund'
     WHEN 'reserve_release' THEN 'reserve_lot' ELSE 'document' END;
   capacity:=(a.payload->>'documented_capacity_cents')::bigint;
   IF a.kind='receipt' THEN
     live:=bank_completion_card_fact(a.source_id);
     SELECT prior_entry.* INTO origin FROM bank_journal_entry prior_entry JOIN bank_journal_line line ON line.entry_id=prior_entry.id
       WHERE prior_entry.kind='merchant_receipt' AND prior_entry.completion_id=a.source_id AND prior_entry.day<=e.day
       AND line.role='clearing' AND line.account_list_id=a.payload->>'account_list_id'
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=prior_entry.id);
     IF origin.id IS NULL OR origin.source_snapshot->'fact'->'payment' IS DISTINCT FROM live
       OR identity->'payment' IS DISTINCT FROM live OR identity->>'origin_entry_id' IS DISTINCT FROM origin.id
       OR identity->>'origin_hash' IS DISTINCT FROM origin.source_hash OR identity->>'account_list_id' IS DISTINCT FROM a.payload->>'account_list_id'
       OR capacity>(live->>'amount')::bigint THEN RAISE EXCEPTION 'BANKING_RECEIPT_SOURCE_STALE'; END IF;
     capacity:=(live->>'amount')::bigint;
   ELSIF a.kind='reserve_release' THEN
     SELECT prior_entry.* INTO origin FROM bank_journal_entry prior_entry JOIN bank_journal_line line ON line.entry_id=prior_entry.id
       WHERE prior_entry.id=split_part(a.source_id,':',1) AND prior_entry.kind='merchant_settlement' AND prior_entry.day<=e.day
       AND line.role=split_part(a.source_id,':',2) AND line.account_list_id=a.payload->>'account_list_id'
       AND NOT EXISTS(SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id=prior_entry.id);
     SELECT debit_cents INTO amount FROM bank_journal_line WHERE entry_id=origin.id AND role=split_part(a.source_id,':',2);
     IF origin.id IS NULL OR capacity>amount OR identity->>'origin_entry_id' IS DISTINCT FROM origin.id
       OR identity->>'origin_hash' IS DISTINCT FROM origin.source_hash THEN RAISE EXCEPTION 'BANKING_RESERVE_LOT_INVALID'; END IF;
     capacity:=amount;
   ELSIF a.kind='refund' THEN
     SELECT COALESCE(cp.metadata->>'refund_txn_date',cp.batch_day),CASE WHEN cp.type='refund' THEN cp.amount::numeric ELSE (cp.metadata->>'refund_amount')::numeric END
       INTO source_date,amount FROM customer_payment cp WHERE cp.id=a.source_id AND cp.deleted_at IS NULL AND lower(cp.currency)='usd'
       AND cp.method IN ('credit_card','debit_card','card') AND cp.status<>'voided'
       AND (cp.type='refund' OR (cp.status IN ('refunded','partial_refunded') AND cp.metadata->>'refund_amount' ~ '^[0-9]+$')) FOR SHARE;
     IF source_date IS NULL OR source_date>a.payload->>'documented_as_of' OR amount IS NULL OR capacity>amount
       THEN RAISE EXCEPTION 'BANKING_DOCUMENTED_CAPACITY_INVALID'; END IF;
   ELSE
     IF a.source_id<>lower(regexp_replace(btrim(a.source_id),'\\s+',' ','g'))
       OR (a.kind='fee' AND EXISTS(${movementExistingExpenseSql("a.source_id")}))
       THEN RAISE EXCEPTION 'BANKING_MOVEMENT_EXPENSE_ALREADY_RECOGNIZED'; END IF;
     IF NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind='document_evidence'
       AND source_id=evidence_hash||':'||(a.payload->>'account_list_id')||':'||CASE WHEN a.kind='fee' THEN 'fee' ELSE 'principal' END
       AND capacity_cents=capacity) THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
   END IF;
   IF NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind=expected_source AND source_id=a.source_id
     AND amount_cents=a.amount_cents AND capacity_cents=capacity AND source_snapshot=identity)
     THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
 END LOOP;
 SELECT count(DISTINCT ev.sha256||':'||(sl.payload->>'account_list_id')||':'||CASE WHEN sl.kind='fee' THEN 'fee' ELSE 'principal' END)
   INTO proof_count FROM bank_merchant_settlement_line sl JOIN bank_evidence_document ev ON ev.id=sl.payload->>'evidence_id'
   WHERE sl.settlement_id=d.id AND sl.kind IN ('fee','chargeback','reserve_hold');
 FOR a IN SELECT ev.sha256||':'||(sl.payload->>'account_list_id')||':'||CASE WHEN sl.kind='fee' THEN 'fee' ELSE 'principal' END proof_id,
   sum(sl.amount_cents) cents FROM bank_merchant_settlement_line sl JOIN bank_evidence_document ev ON ev.id=sl.payload->>'evidence_id'
   WHERE sl.settlement_id=d.id AND sl.kind IN ('fee','chargeback','reserve_hold')
   GROUP BY ev.sha256,sl.payload->>'account_list_id',CASE WHEN sl.kind='fee' THEN 'fee' ELSE 'principal' END LOOP
   IF NOT EXISTS(SELECT 1 FROM bank_source_claim WHERE entry_id=e.id AND source_kind='document_evidence' AND source_id=a.proof_id
     AND amount_cents=a.cents) THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM bank_source_claim WHERE entry_id=e.id)<>total_lines+proof_count+(CASE WHEN e.transaction_id IS NULL THEN 0 ELSE 1 END)
   THEN RAISE EXCEPTION 'BANKING_SOURCE_CLAIM_INVALID'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_completion_merchant_entry AFTER INSERT ON bank_journal_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_completion_merchant_contract();
CREATE CONSTRAINT TRIGGER bank_completion_merchant_line AFTER INSERT ON bank_journal_line
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_completion_merchant_contract();
CREATE CONSTRAINT TRIGGER bank_completion_merchant_claim AFTER INSERT ON bank_source_claim
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bank_completion_merchant_contract();
`;
