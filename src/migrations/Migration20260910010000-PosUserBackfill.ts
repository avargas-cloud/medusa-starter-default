import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Backfill de `pos_user`: cada usuario de Medusa vivo pasa a tener su fila.
 *
 * Por qué: hasta el 2026-09-09 el POS derivaba "es admin" de una AUSENCIA —
 * un usuario de Medusa que no estaba en `pos_user` podía todo. Una regla que
 * se cumple por omisión no se puede auditar (no hay fila que mirar) ni revocar
 * (no hay fila que editar), y convertía cada alta de usuario en un admin sin
 * que nadie lo decidiera. El operador la eliminó: desde ahora Admin es
 * `pos_user.is_admin`, un dato explícito.
 *
 * Para que NADIE pierda hoy el acceso que tenía ayer, los que entran por este
 * backfill entran con `is_admin=TRUE`: la fila describe el estado actual, no lo
 * cambia. Sacarle el flag a quien no deba tenerlo es una decisión posterior y
 * deliberada, que ahora es posible porque hay una fila donde hacerla.
 *
 * `can_view_accounting=false` a propósito: Accounting NO se hereda de esto,
 * vive en `pos_accounting_grant` (ver Migration20260910000000).
 *
 * SOLO la tabla `"user"` (staff). `customer` no se toca ni por error: un
 * cliente del e-commerce no es personal del POS.
 */
export class PosUserBackfill20260910010000 implements MigrationInterface {
  name = "PosUserBackfill20260910010000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // El id se genera por FILA (dentro del LOOP): un SELECT no correlacionado
    // se evalúa una sola vez como InitPlan y todos compartirían el mismo id.
    // Forma: 26 chars del alfabeto Crockford, como los ULID que ya viven ahí.
    await queryRunner.query(`
      DO $$
      DECLARE staff RECORD; new_id TEXT;
      BEGIN
        FOR staff IN
          SELECT mu.id, mu.email, mu.first_name, mu.last_name
            FROM "user" mu
           WHERE mu.deleted_at IS NULL
             AND COALESCE(trim(mu.email), '') <> ''
             AND NOT EXISTS (
               SELECT 1 FROM pos_user p
                WHERE lower(p.email) = lower(mu.email) AND p.deleted_at IS NULL)
        LOOP
          SELECT string_agg(
                   substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                          1 + floor(random() * 32)::int, 1), '')
            INTO new_id
            FROM generate_series(1, 26);
          INSERT INTO pos_user
            (id, email, first_name, last_name, can_view_accounting, is_admin, created_at, updated_at)
          VALUES
            (new_id, lower(staff.email), COALESCE(staff.first_name, ''),
             COALESCE(staff.last_name, ''), false, true, NOW(), NOW());
        END LOOP;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // A propósito NO revierte. Las filas creadas acá son indistinguibles de las
    // que un admin creó a mano (no hay columna que las marque), así que un
    // rollback borraría staff legítimo. Revertir la REGLA se hace en
    // `lib/pos/access-level.ts`, no borrando personal.
  }
}
