import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * vc-apply-qb-20260915: en QuickBooks no existe "enganchar un crédito a un
 * bill" como documento propio — la única forma es un Pay Bills de $0
 * (`BillPaymentCreditCardAddRq` con `PaymentAmount 0.00` + `SetCredit`), y
 * QuickBooks lo acepta SIN crear ningún `BillPaymentCreditCardRet.TxnID`
 * (probado en prod 09/15/2026, 6 veces: `statusCode 0`, sin TxnID). No hay
 * documento que guardar como `qb_txn_id` propio — el enlace se prueba
 * releyendo el bill (`BillQueryRq` + `IncludeLinkedTxns`) y viendo su
 * `LinkedTxn{TxnType=VendorCredit}`. `qb_applied_at` es la fecha que
 * confirma que ese viaje ocurrió (readback exitoso), no una fecha de
 * creación de documento.
 *
 * Expand-only: columnas nullable; ningún lector las exige.
 */
export class VendorCreditApplicationQb20260915150000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE vendor_credit_application ADD COLUMN IF NOT EXISTS qb_applied_at timestamptz NULL`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit_application ADD COLUMN IF NOT EXISTS qb_bill_txn_id text NULL`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit_application ADD COLUMN IF NOT EXISTS qb_credit_txn_id text NULL`
    );
    await queryRunner.query(
      // Sólo por si QuickBooks alguna vez devolviera un TxnID para este $0
      // apply — el readback documenta que no lo hace, pero guardarlo si
      // aparece es gratis y evita perder la evidencia.
      `ALTER TABLE vendor_credit_application ADD COLUMN IF NOT EXISTS qb_payment_txn_id text NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE vendor_credit_application DROP COLUMN IF EXISTS qb_payment_txn_id`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit_application DROP COLUMN IF EXISTS qb_credit_txn_id`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit_application DROP COLUMN IF EXISTS qb_bill_txn_id`
    );
    await queryRunner.query(
      `ALTER TABLE vendor_credit_application DROP COLUMN IF EXISTS qb_applied_at`
    );
  }
}
