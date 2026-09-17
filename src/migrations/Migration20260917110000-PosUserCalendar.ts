import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * pos-calendars-20260917 — el calendario personal del POS vive en Google
 * (calendario secundario "EcoPowerTech POS" en la cuenta del usuario), y esta
 * tabla sólo recuerda QUÉ calendario creó la app para cada usuario. Con el
 * scope `calendar.app.created` la Service Account no puede listar ni leer la
 * agenda personal: por eso el id se guarda acá en vez de buscarse cada vez.
 *
 * `email` se copia al crear para detectar el caso "el usuario cambió de email":
 * un calendario creado bajo otra cuenta no se reutiliza, se crea uno nuevo.
 */
export class PosUserCalendar20260917110000 implements MigrationInterface {
  name = "PosUserCalendar20260917110000";

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`SET LOCAL lock_timeout = '15s'`);
    await q.query(`
      CREATE TABLE IF NOT EXISTS pos_user_calendar (
        user_id             text PRIMARY KEY,
        email               text NOT NULL,
        google_calendar_id  text NOT NULL,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS pos_user_calendar`);
  }
}
