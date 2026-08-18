import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Order Commissions — un bill vivo, un settlement (Fix A.1).
 *
 * El índice hermano `uq_cset_live_per_recipient` garantiza "un beneficiario,
 * una liquidación viva", pero NO impedía que DOS beneficiarios distintos
 * apuntaran al MISMO vendor bill — y como `validateVendorBillForSettlement`
 * exige que el bill totalice EXACTAMENTE el monto aprobado, dos beneficiarios
 * con el mismo monto (p.ej. dos al mismo % de la misma orden) podían
 * liquidarse contra un solo bill, cerrando los dos y contando la plata dos
 * veces en el acumulado 1099. `failed`/`reversed` quedan fuera del predicado
 * a propósito: liberan el bill para un reintento legítimo.
 */
export class AddCommissionSettlementBillUniqueness1783000000000 implements MigrationInterface {
  name = "AddCommissionSettlementBillUniqueness1783000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_cset_live_per_bill
        ON commission_settlement (vendor_bill_id)
        WHERE vendor_bill_id IS NOT NULL
          AND status IN ('pending','qb_waiting','confirmed')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS uq_cset_live_per_bill`);
  }
}
