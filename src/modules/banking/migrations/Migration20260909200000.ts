import { Migration } from "@medusajs/framework/mikro-orm/migrations";
import { statementGuardSql } from "../../../lib/banking/statement-guard-sql";
import { statementMatchSql } from "../../../lib/banking/statement-match-sql";

/** Independent statement evidence and reconciliation; never creates journal entries. */
export class Migration20260909200000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`CREATE TABLE bank_statement (
      id text PRIMARY KEY,revision integer NOT NULL CHECK(revision>0),status text NOT NULL CHECK(status IN ('draft','closed')),
      bank_account_id text NOT NULL REFERENCES bank_account(id),account_list_id text NOT NULL,
      opening_id text NOT NULL REFERENCES bank_opening_balance(id),predecessor_id text REFERENCES bank_statement(id),
      from_day text NOT NULL,to_day text NOT NULL,payload jsonb NOT NULL,evidence_id text NOT NULL REFERENCES bank_evidence_document(id),
      closed_by text,closed_at timestamptz,input_hash text,closed_snapshot jsonb,history jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz,
      CHECK(from_day~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND to_day~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND from_day::date>=DATE '1900-01-01' AND to_day::date<=DATE '2200-12-31' AND from_day<=to_day),
      CHECK(jsonb_typeof(history)='array'),UNIQUE(account_list_id,from_day,to_day));
      CREATE INDEX idx_bank_statement_period ON bank_statement(account_list_id,from_day,to_day);
      CREATE TABLE bank_statement_line (
      id text PRIMARY KEY,statement_id text NOT NULL REFERENCES bank_statement(id),external_key text NOT NULL,
      day text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents<>0 AND abs(amount_cents)<=999999999999),
      description text NOT NULL,transaction_id text REFERENCES bank_transaction(id),source_hash text NOT NULL,source_snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
      CREATE UNIQUE INDEX uq_bank_statement_line_key ON bank_statement_line(statement_id,lower(trim(external_key))) WHERE deleted_at IS NULL;
      CREATE UNIQUE INDEX uq_bank_statement_line_transaction ON bank_statement_line(transaction_id) WHERE transaction_id IS NOT NULL AND deleted_at IS NULL;
      CREATE TABLE bank_statement_match (
      id text PRIMARY KEY,statement_id text NOT NULL REFERENCES bank_statement(id),statement_line_id text NOT NULL REFERENCES bank_statement_line(id),
      book_kind text NOT NULL CHECK(book_kind IN ('journal_line','opening_item')),book_id text NOT NULL,
      amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 1 AND 999999999999),book_hash text NOT NULL,line_hash text NOT NULL,
      actor_id text NOT NULL,removed_by text,removed_reason text,created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz);
      CREATE INDEX idx_bank_statement_match_book ON bank_statement_match(book_kind,book_id) WHERE deleted_at IS NULL;
      CREATE INDEX idx_bank_statement_match_line ON bank_statement_match(statement_line_id) WHERE deleted_at IS NULL;`);
    this.addSql(statementGuardSql);
    this.addSql(statementMatchSql);
  }
  override async down(): Promise<void> { throw new Error("Statement history requires explicit reviewed rollback."); }
}
