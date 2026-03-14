-- ============================================================
-- Customer Credit Ledger
-- Created: 2026-03-06
-- Purpose: Track unapplied customer credits for POS "pay later"
--          and multi-invoice payment allocation flows.
--
-- Run once:
--   psql $DATABASE_URL -f scripts/create-credit-ledger.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_credit_ledger (
    id              TEXT PRIMARY KEY DEFAULT 'cred_' || gen_random_uuid()::text,
    customer_id     TEXT        NOT NULL,        -- Medusa customer ID
    amount          NUMERIC(12,2) NOT NULL,      -- always positive (absolute value)
    type            TEXT        NOT NULL,        -- 'credit' | 'debit'
    -- credit: money added to the customer's account (payment received without invoice)
    -- debit:  money applied against a specific order

    reference_id    TEXT,                        -- order_id when type='debit'; payment ref when type='credit'
    reference_type  TEXT,                        -- 'order' | 'payment' | 'adjustment' | 'refund'
    note            TEXT,                        -- human-readable description
    created_by      TEXT,                        -- Medusa user ID who created this entry
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast customer balance queries
CREATE INDEX IF NOT EXISTS idx_credit_ledger_customer
    ON customer_credit_ledger (customer_id, created_at DESC);

-- Index for looking up credits by reference (e.g. order_id)
CREATE INDEX IF NOT EXISTS idx_credit_ledger_reference
    ON customer_credit_ledger (reference_id)
    WHERE reference_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- Usage examples (for reference only, not run by this script)
-- ────────────────────────────────────────────────────────────

-- Add $500 credit (customer paid without specifying an invoice):
-- INSERT INTO customer_credit_ledger
--   (customer_id, amount, type, reference_type, note, created_by)
--   VALUES ('cus_01ABC', 500.00, 'credit', 'payment', 'Check #1234 received', 'usr_01XYZ');

-- Apply $200 of credit to Order #1089:
-- INSERT INTO customer_credit_ledger
--   (customer_id, amount, type, reference_id, reference_type, note, created_by)
--   VALUES ('cus_01ABC', 200.00, 'debit', 'order_01QRS', 'order', 'Applied to Order #1089', 'usr_01XYZ');

-- Get current balance for a customer:
-- SELECT
--   SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS balance
-- FROM customer_credit_ledger
-- WHERE customer_id = 'cus_01ABC';
