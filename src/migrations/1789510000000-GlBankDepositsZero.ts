import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * record-deposits-gl-20260915 v4 — un depósito de $0.00 es un documento
 * legítimo de Make Deposits: así se sacan de Undeposited Funds dos ítems que
 * se anulan (el cobro #3520 +315.86 y el JE-0006 −315.86 del 09/15/2026),
 * sin mover ningún saldo. `bank_deposit.gross_amount`/`net_amount` pasan de
 * `> 0` a `>= 0`; las líneas siguen siendo ≠ 0. Expand-only.
 */
export class GlBankDepositsZero1789510000000 implements MigrationInterface {
  name = "GlBankDepositsZero1789510000000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`ALTER TABLE bank_deposit DROP CONSTRAINT IF EXISTS bank_deposit_gross_amount_check`);
    await q.query(`ALTER TABLE bank_deposit ADD CONSTRAINT bank_deposit_gross_amount_check CHECK (gross_amount::numeric >= 0::numeric)`);
    await q.query(`ALTER TABLE bank_deposit DROP CONSTRAINT IF EXISTS bank_deposit_net_amount_check`);
    await q.query(`ALTER TABLE bank_deposit ADD CONSTRAINT bank_deposit_net_amount_check CHECK (net_amount::numeric >= 0::numeric)`);
  }

  public async down(): Promise<void> {
    throw new Error("GlBankDepositsZero1789510000000: expand-only — reviewed rollback only.");
  }
}
