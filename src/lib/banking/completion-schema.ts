export const completionSchemaSql = `
CREATE TABLE bank_evidence_document (
  id text PRIMARY KEY,original_name text NOT NULL,mime_type text NOT NULL CHECK(mime_type='application/pdf'),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 5242880),sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  version integer NOT NULL CHECK(version>0),content_base64 text NOT NULL,uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE TABLE bank_movement (
  id text PRIMARY KEY,revision integer NOT NULL CHECK(revision>0),kind text NOT NULL CHECK(kind IN
    ('obligation_payment','payroll_match','wire_match','refund_match','bank_transfer','credit_card_payment','loan_payment','owner_contribution','owner_withdrawal','advance')),
  reference text NOT NULL CHECK(length(trim(reference))>0),payload jsonb NOT NULL,source_snapshot jsonb NOT NULL,
  created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
CREATE TABLE bank_movement_allocation (
  id text PRIMARY KEY,movement_id text NOT NULL REFERENCES bank_movement(id),sort_order integer NOT NULL,
  source_kind text NOT NULL,source_id text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),
  capacity_cents bigint CHECK(capacity_cents BETWEEN 1 AND 999999999999),payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
  UNIQUE(movement_id,sort_order),UNIQUE(movement_id,source_kind,source_id));
ALTER TABLE bank_journal_entry ADD COLUMN completion_id text,ADD COLUMN completion_stage text;
ALTER TABLE bank_journal_entry DROP CONSTRAINT bank_journal_kind;
ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_kind CHECK(kind IN
  ('expense','receipt','deposit','payment_match','reversal','movement','merchant_settlement','merchant_receipt'));
ALTER TABLE bank_journal_entry ADD CONSTRAINT bank_journal_completion_shape CHECK(
  (completion_id IS NULL AND completion_stage IS NULL AND kind NOT IN ('movement','merchant_settlement','merchant_receipt'))
  OR (completion_id IS NOT NULL AND length(trim(completion_id))>0 AND completion_stage IS NOT NULL AND length(trim(completion_stage))>0
    AND kind IN ('movement','merchant_settlement','merchant_receipt','reversal') AND expense_id IS NULL AND receipt_id IS NULL AND deposit_id IS NULL));
ALTER TABLE bank_journal_line DROP CONSTRAINT bank_journal_role;
ALTER TABLE bank_journal_line ADD CONSTRAINT bank_journal_role CHECK(role ~ '^[a-z][a-z0-9_]{0,79}$');
CREATE INDEX idx_bank_completion_journal ON bank_journal_entry(completion_id,completion_stage,created_at);
CREATE TABLE bank_source_claim (
  id text PRIMARY KEY,entry_id text NOT NULL REFERENCES bank_journal_entry(id),source_kind text NOT NULL,source_id text NOT NULL,
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),
  capacity_cents bigint NOT NULL CHECK(capacity_cents BETWEEN amount_cents AND 999999999999),
  source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),source_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
  UNIQUE(entry_id,source_kind,source_id));
CREATE INDEX idx_bank_source_claim_identity ON bank_source_claim(source_kind,source_id,entry_id);
CREATE TRIGGER bank_source_claim_immutable BEFORE UPDATE OR DELETE ON bank_source_claim FOR EACH ROW EXECUTE FUNCTION bank_journal_immutable();
CREATE TRIGGER bank_evidence_document_immutable BEFORE UPDATE OR DELETE ON bank_evidence_document FOR EACH ROW EXECUTE FUNCTION bank_journal_immutable();
CREATE FUNCTION bank_completion_document_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text; destination text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('banking-review',7241));
  IF TG_TABLE_NAME='bank_movement' THEN target:=OLD.id;
  ELSE
    IF TG_OP<>'INSERT' THEN target:=OLD.movement_id; END IF;
    IF TG_OP<>'DELETE' THEN destination:=NEW.movement_id; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM bank_journal_entry WHERE completion_id IN (target,destination)) THEN RAISE EXCEPTION 'BANKING_MOVEMENT_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER bank_movement_immutable BEFORE UPDATE OR DELETE ON bank_movement FOR EACH ROW EXECUTE FUNCTION bank_completion_document_guard();
CREATE TRIGGER bank_movement_allocation_immutable BEFORE INSERT OR UPDATE OR DELETE ON bank_movement_allocation FOR EACH ROW EXECUTE FUNCTION bank_completion_document_guard();
`;
