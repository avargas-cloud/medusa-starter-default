import { MigrationInterface, QueryRunner } from "typeorm";

import { completionClaimSql } from "../lib/banking/completion-claim-sql";
import { statementGuardSql } from "../lib/banking/statement-guard-sql";
import { statementMatchSql } from "../lib/banking/statement-match-sql";

/**
 * Banking-on-GL §3 items 3-5 / §5 — Banking statements stop reading the
 * retired `bank_opening_balance` declaration and read the GL `opening_balance`
 * document instead (`bank_journal_entry.source_kind='opening_balance'`,
 * `source_id=<account_list_id>`, line role `opening` / `uncleared_<key>`).
 *
 * Expand-only:
 * 1. `bank_statement_match.book_kind` CHECK -> only 'journal_line'. Guarded:
 *    if any 'opening_item' row exists this does NOT alter anything (a
 *    contract deploy is required first).
 * 2. Recreate the trigger/function bodies whose TS source changed
 *    (`statement-guard-sql.ts`, `statement-match-sql.ts`,
 *    `completion-claim-sql.ts`) — same names/signatures, new bodies.
 * 3. `bank_deposit_line` gets two nullable columns for the manual
 *    Undeposited-Funds deposit line (pre-cutover receipts with no
 *    `payment_id`, POS contract: `{payment_id: null, manual: true,
 *    reference, description, amount}`).
 *
 * Nothing from the retired openings feature is dropped: `bank_opening_*`
 * tables/columns stay (contract in a later deploy).
 */
export class BankingOnGlStatements1789100000000 implements MigrationInterface {
  name = "BankingOnGlStatements1789100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ n }] = (await queryRunner.query(
      `SELECT COUNT(*)::int AS n FROM bank_statement_match WHERE book_kind='opening_item'`
    )) as [{ n: number }];
    if (n > 0) {
      throw new Error(
        `BankingOnGlStatements1789100000000: ${n} bank_statement_match row(s) still use book_kind='opening_item'; ` +
          "refusing to narrow the CHECK or recreate the statement/completion triggers. Migrate those rows first."
      );
    }

    // -- Drop the triggers this migration's SQL modules recreate ------------
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_document_guard ON bank_statement`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_line_guard ON bank_statement_line`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_match_guard ON bank_statement_match`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_journal_guard ON bank_journal_line`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_account_guard ON bank_account`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_opening_guard ON bank_opening_balance`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_opening_clear_guard ON bank_opening_clear`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_review_guard ON bank_transaction_review`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_deposit_guard ON bank_deposit`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_deposit_line_guard ON bank_deposit_line`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_historical_claim_guard ON bank_journal_entry`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_match_capacity ON bank_statement_match`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_statement_close_valid ON bank_statement`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_completion_claim_insert ON bank_source_claim`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_completion_legacy_journal ON bank_journal_entry`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_completion_legacy_opening ON bank_opening_clear`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_completion_legacy_adopt ON bank_opening_balance`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_completion_legacy_deposit ON bank_deposit_line`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_completion_legacy_review ON bank_transaction_review`
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS bank_completion_legacy_consumption ON bank_receipt_consumption`
    );

    // -- Drop the functions those triggers (and each other) call ------------
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_statement_assert_open(text,text)`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_statement_document_guard()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_statement_journal_guard()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_statement_evidence_guard()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_statement_historical_claim_guard()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_statement_match_capacity()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_statement_check_close()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_completion_legacy_reserved(text,text)`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_completion_active_claims(text,text,text)`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_completion_validate_claim(text,text,bigint,bigint,text,text)`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_completion_claim_insert()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS bank_completion_legacy_guard()`
    );

    // -- Reinstall the same names/signatures with the banking-on-gl bodies ---
    await queryRunner.query(completionClaimSql);
    await queryRunner.query(statementGuardSql);
    await queryRunner.query(statementMatchSql);

    // -- book_kind: 'opening_item' retired, guarded empty above --------------
    await queryRunner.query(
      `ALTER TABLE bank_statement_match DROP CONSTRAINT IF EXISTS bank_statement_match_book_kind_check`
    );
    await queryRunner.query(`
      ALTER TABLE bank_statement_match ADD CONSTRAINT bank_statement_match_book_kind_check
        CHECK (book_kind = 'journal_line')
    `);

    // -- manual Undeposited-Funds deposit line (no payment_id) ---------------
    await queryRunner.query(`
      ALTER TABLE bank_deposit_line
        ADD COLUMN IF NOT EXISTS manual_reference text,
        ADD COLUMN IF NOT EXISTS manual_description text
    `);
    // -- statements anchor on the GL opening_balance entry, not the retired bank_opening_balance ----
    // Found by guided-review case 18: every statement save failed the old FK. Entries are immutable and
    // never deleted, so the new FK is safe; NOT VALID skips legacy rows that still point at bob_* ids.
    await queryRunner.query(
      `ALTER TABLE bank_statement DROP CONSTRAINT IF EXISTS bank_statement_opening_id_fkey`
    );
    await queryRunner.query(`
      ALTER TABLE bank_statement
        ADD CONSTRAINT bank_statement_opening_entry_fkey
        FOREIGN KEY (opening_id) REFERENCES bank_journal_entry(id) NOT VALID
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      "Banking statement/completion trigger history requires reviewed rollback."
    );
  }
}
