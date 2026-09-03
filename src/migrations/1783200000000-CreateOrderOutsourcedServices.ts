import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Order Outsourced Services v1 — el COSTO de un servicio que se subcontrata
 * (programación, armado, instalación en sitio) atado a una orden de VENTA.
 *
 * Es primo de Order Commissions y a propósito NO comparte sus tablas: coinciden
 * sólo en el tramo final (validar un vendor bill y conciliarlo por `qb_txn_id`).
 * Difieren en identidad (acá SIEMPRE vendor), en monto (fijo, nunca un % de la
 * orden), en devengo (no hay: no existe `eligible` ni `wait_days`) y en payout
 * (no hay store credit). Un `kind` discriminador habría dejado media docena de
 * columnas nulas y constraints condicionados sobre un flujo de dinero ya vivo.
 *
 * Tres diferencias con el molde de comisiones que son decisiones, no descuidos:
 *
 * 1. NO hay header por orden. Comisiones tiene uno porque el cap es por orden;
 *    acá una venta puede llevar programación de un vendor, armado de otro e
 *    instalación de un tercero — son N obligaciones independientes.
 *
 * 2. NO hay unicidad por (orden, vendor, tipo). Dos visitas del mismo instalador
 *    a la misma obra son legítimas; una regla que lo impida es falsa. El duplicado
 *    accidental se ataja por `vendor_invoice_number` y por la UI, no por el esquema.
 *
 * 3. El estado terminal se llama `posted`, no `closed`. `vendor_bill.qb_txn_id`
 *    prueba que el bill se ASENTÓ en QuickBooks, no que el subcontratista cobró:
 *    el pago de AP es otro ciclo y no lo modela esta feature.
 *
 * `outsourced_service_settlement` es append-only. Sus dos índices parciales son
 * el candado del dinero: un settlement vivo por servicio y un bill reclamado por
 * un solo settlement. `failed`/`reversed` quedan FUERA de los predicados a
 * propósito — liberan para un reintento legítimo.
 */
export class CreateOrderOutsourcedServices1783200000000
  implements MigrationInterface
{
  name = "CreateOrderOutsourcedServices1783200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Catálogo de tipos ────────────────────────────────────────────────────
    // Va en tabla y no en `store.metadata` porque mapea cada tipo a una cuenta
    // contable: eso necesita integridad referencial y auditoría, no JSON laxo
    // detrás de un cache de 60 s. Un CHECK enum tampoco sirve — agregar un tipo
    // sería una migración en vez de una fila.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outsourced_service_type (
        id                    text PRIMARY KEY,
        code                  text NOT NULL,
        display_name          text NOT NULL,
        qb_account_list_id    text NULL,
        qb_account_full_name  text NULL,
        sort_order            integer NOT NULL DEFAULT 0,
        is_active             boolean NOT NULL DEFAULT true,
        created_at            timestamptz NOT NULL DEFAULT NOW(),
        updated_at            timestamptz NOT NULL DEFAULT NOW(),
        deleted_at            timestamptz NULL,
        CONSTRAINT chk_ostp_code CHECK (code ~ '^[a-z0-9_]+$'),
        CONSTRAINT chk_ostp_account_pair CHECK (
          (qb_account_list_id IS NULL     AND qb_account_full_name IS NULL)
       OR (qb_account_list_id IS NOT NULL AND qb_account_full_name IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_ostp_code_live
        ON outsourced_service_type (code)
        WHERE deleted_at IS NULL
    `);

    // ── La obligación ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS order_outsourced_service (
        id                     text PRIMARY KEY,
        order_id               text NOT NULL,
        display_number         bigint NULL,
        currency_code          text NOT NULL DEFAULT 'usd',
        qb_vendor_id           text NOT NULL,
        vendor_display_name    text NOT NULL,
        service_type_id        text NOT NULL REFERENCES outsourced_service_type(id),
        service_type_code      text NOT NULL,
        service_type_name      text NOT NULL,
        qb_account_list_id     text NULL,
        qb_account_full_name   text NULL,
        amount_cents           bigint NOT NULL,
        description            text NULL,
        vendor_invoice_number  text NULL,
        state                  text NOT NULL DEFAULT 'draft',
        assigned_by            text NULL,
        assigned_at            timestamptz NOT NULL DEFAULT NOW(),
        approved_by            text NULL,
        approved_at            timestamptz NULL,
        settled_by             text NULL,
        settled_at             timestamptz NULL,
        void_reason            text NULL,
        created_at             timestamptz NOT NULL DEFAULT NOW(),
        updated_at             timestamptz NOT NULL DEFAULT NOW(),
        deleted_at             timestamptz NULL,
        CONSTRAINT chk_oos_state
          CHECK (state IN ('draft','approved','settling','posted','void')),
        CONSTRAINT chk_oos_amount CHECK (amount_cents > 0),
        -- Aprobar CONGELA la obligación: número contable y cuenta de gasto.
        -- Cambiar el catálogo después no puede reinterpretar lo ya autorizado.
        CONSTRAINT chk_oos_approved_is_frozen CHECK (
          state IN ('draft','void')
          OR (display_number IS NOT NULL AND qb_account_list_id IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_oos_order
        ON order_outsourced_service (order_id)
        WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_oos_state
        ON order_outsourced_service (state)
        WHERE deleted_at IS NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_oos_vendor
        ON order_outsourced_service (qb_vendor_id)
        WHERE deleted_at IS NULL
    `);
    // Sin predicado por deleted_at: un OSV- soft-borrado no puede reciclar su
    // número, igual que uq_order_commission_display_number.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_oos_display_number
        ON order_outsourced_service (display_number)
        WHERE display_number IS NOT NULL
    `);

    // ── Liquidación (append-only) ────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outsourced_service_settlement (
        id               text PRIMARY KEY,
        service_id       text NOT NULL REFERENCES order_outsourced_service(id),
        amount_cents     bigint NOT NULL,
        vendor_bill_id   text NULL,
        status           text NOT NULL DEFAULT 'pending',
        failure_reason   text NULL,
        idempotency_key  text NOT NULL,
        created_by       text NULL,
        created_at       timestamptz NOT NULL DEFAULT NOW(),
        updated_at       timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT chk_osst_status
          CHECK (status IN ('pending','qb_waiting','confirmed','failed','reversed')),
        CONSTRAINT chk_osst_amount CHECK (amount_cents > 0),
        CONSTRAINT uq_osst_idempotency UNIQUE (idempotency_key)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_osst_live_per_service
        ON outsourced_service_settlement (service_id)
        WHERE status IN ('pending','qb_waiting','confirmed')
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_osst_live_per_bill
        ON outsourced_service_settlement (vendor_bill_id)
        WHERE vendor_bill_id IS NOT NULL
          AND status IN ('pending','qb_waiting','confirmed')
    `);

    // ── Seeds ────────────────────────────────────────────────────────────────
    // La cuenta se RESUELVE por full_name contra el espejo `qb_account`, no se
    // hardcodea un ListID: así el seed vale igual en sandbox y en producción, y
    // si la cuenta no existe el tipo nace sin cuenta (su kill switch lo apaga)
    // en vez de nacer apuntando a un ListID inventado.
    await queryRunner.query(`
      INSERT INTO outsourced_service_type
        (id, code, display_name, qb_account_list_id, qb_account_full_name, sort_order)
      SELECT s.id, s.code, s.display_name, a.qb_list_id, a.full_name, s.sort_order
        FROM (VALUES
                ('ostp_programming',         'programming',         'Programming',         10),
                ('ostp_assembly',            'assembly',            'Assembly',            20),
                ('ostp_on_site_installation','on_site_installation','On Site Installation', 30)
             ) AS s(id, code, display_name, sort_order)
        LEFT JOIN qb_account a
               ON a.full_name = 'Subcontractor Labor'
              AND a.deleted_at IS NULL
              AND a.is_active = true
       ON CONFLICT (id) DO NOTHING
    `);

    // Numeración OSV-#### gapless. Se reclama al APROBAR (no al crear): un
    // borrador descartado no debe quemar un número contable.
    await queryRunner.query(`
      INSERT INTO document_number_counter (name, value)
      VALUES ('order_outsourced_service', 1000)
      ON CONFLICT (name) DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM document_number_counter WHERE name = 'order_outsourced_service'`
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS outsourced_service_settlement`
    );
    await queryRunner.query(`DROP TABLE IF EXISTS order_outsourced_service`);
    await queryRunner.query(`DROP TABLE IF EXISTS outsourced_service_type`);
  }
}
