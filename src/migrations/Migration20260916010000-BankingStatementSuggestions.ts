import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * bank-feed-suggestions-20260915: el casador ya no ESCRIBE matches hacia adelante — SUGIERE.
 * `bank_statement_suggestion` guarda, por línea del extracto en borrador, lo que el casador
 * propone (asiento(s) del libro con su hash, o alternativas si es ambigua); el contador confirma
 * desde el Bank Feed. `bank_suggestion_run` es la métrica de cada corrida (job diario, botón
 * Refresh, recálculo tras un Confirm): duración, líneas agregadas al borrador, candidatos.
 *
 * Expand-only: dos tablas nuevas, ningún cambio sobre tablas existentes.
 */
export class BankingStatementSuggestions20260916010000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS bank_suggestion_run (
      id text PRIMARY KEY,
      account_id text NOT NULL,
      statement_id text NULL,
      month text NOT NULL,
      trigger text NOT NULL,
      actor_id text NULL,
      engine_version text NOT NULL,
      status text NOT NULL,
      skipped_reason text NULL,
      error text NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz NULL,
      duration_ms integer NULL,
      lines integer NOT NULL DEFAULT 0,
      appended_lines integer NOT NULL DEFAULT 0,
      drifted_lines integer NOT NULL DEFAULT 0,
      matched_lines integer NOT NULL DEFAULT 0,
      suggested_lines integer NOT NULL DEFAULT 0,
      ambiguous_lines integer NOT NULL DEFAULT 0,
      candidates integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL,
      CONSTRAINT bank_suggestion_run_trigger_check CHECK (trigger IN ('job','manual','confirm')),
      CONSTRAINT bank_suggestion_run_status_check CHECK (status IN ('ok','skipped','failed'))
    )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_bank_suggestion_run_account ON bank_suggestion_run(account_id, started_at DESC)`
    );
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS bank_statement_suggestion (
      id text PRIMARY KEY,
      statement_id text NOT NULL,
      statement_line_id text NOT NULL,
      transaction_id text NULL,
      account_id text NOT NULL,
      kind text NOT NULL,
      stage text NULL,
      candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
      alternatives jsonb NOT NULL DEFAULT '[]'::jsonb,
      payee_name text NULL,
      engine_version text NOT NULL,
      statement_revision integer NOT NULL,
      run_id text NOT NULL,
      computed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz NULL,
      CONSTRAINT bank_statement_suggestion_kind_check CHECK (kind IN ('match','ambiguous','none'))
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_statement_suggestion_line ON bank_statement_suggestion(statement_line_id) WHERE deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_bank_statement_suggestion_tx ON bank_statement_suggestion(transaction_id) WHERE deleted_at IS NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_bank_statement_suggestion_statement ON bank_statement_suggestion(statement_id) WHERE deleted_at IS NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS bank_statement_suggestion`);
    await queryRunner.query(`DROP TABLE IF EXISTS bank_suggestion_run`);
  }
}
