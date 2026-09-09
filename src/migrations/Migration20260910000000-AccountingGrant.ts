import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * pos_accounting_grant — el acceso a Accounting deja de ser un booleano suelto
 * en `pos_user` y pasa a ser un OTORGAMIENTO con autor, fecha y revocación.
 *
 * Por qué: `pos_user.can_view_accounting` se escribía por `PATCH
 * /admin/pos-users/:id` SIN ninguna autorización, y todo usuario de Medusa
 * ausente de `pos_user` era "full admin" por definición. O sea que el permiso
 * más caro del POS se regalaba con cada alta y se cambiaba sin dejar rastro.
 * Acá el rastro ES la tabla: nunca se borra una fila, se revoca (`revoked_at`).
 *
 * El índice único PARCIAL sobre `(user_id) WHERE revoked_at IS NULL` es la
 * regla entera: un usuario puede tener muchas filas históricas y como máximo
 * un grant vivo, así que otorgar dos veces es idempotente por construcción.
 *
 * `pos_user.is_admin` viaja en la misma migración: es la otra mitad de la
 * separación. NO abre las pantallas de Admin Tools (esas son owner-only, y el
 * owner vive en `POS_OWNER_EMAILS`, no en la base): marca al staff que puede
 * confirmar una operación con PIN escribiendo `confirm` en vez del PIN.
 * Accounting y Admin son flags INDEPENDIENTES (`src/lib/pos/access-level.ts`).
 *
 * La columna vieja `can_view_accounting` NO se borra: se deja de leer para
 * autorizar, y las rutas la siguen devolviendo derivada del grant para que los
 * clientes viejos no se rompan.
 */
export class AccountingGrant20260910000000 implements MigrationInterface {
  name = "AccountingGrant20260910000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS pos_accounting_grant (
        id            TEXT PRIMARY KEY,
        user_id       TEXT        NOT NULL,
        email         TEXT        NOT NULL,
        granted_by    TEXT        NOT NULL,
        granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_by    TEXT        NULL,
        revoked_at    TIMESTAMPTZ NULL,
        revoke_reason TEXT        NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_accounting_grant_active
        ON pos_accounting_grant (user_id) WHERE revoked_at IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE pos_user ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Backfill: cada can_view_accounting=true vivo se convierte en un grant activo.
    // El grant se keyea por el id del usuario de MEDUSA (es lo que trae el JWT);
    // `pos_user` sólo guarda el email, así que el join es por email. Un pos_user
    // sin usuario de Medusa no puede autenticarse, y por eso no genera grant.
    await queryRunner.query(`
      INSERT INTO pos_accounting_grant (id, user_id, email, granted_by)
      SELECT DISTINCT ON (u.id)
             'pag_' || replace(gen_random_uuid()::text, '-', ''),
             u.id, lower(p.email), 'migration-20260910'
        FROM pos_user p
        JOIN "user" u ON lower(u.email) = lower(p.email) AND u.deleted_at IS NULL
       WHERE p.can_view_accounting IS TRUE AND p.deleted_at IS NULL
       ORDER BY u.id
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS pos_accounting_grant`);
    await queryRunner.query(
      `ALTER TABLE pos_user DROP COLUMN IF EXISTS is_admin`
    );
  }
}
