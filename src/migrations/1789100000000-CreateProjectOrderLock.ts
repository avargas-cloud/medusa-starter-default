import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * project_order_lock — el candado proyecto ↔ orden de las apps de diseño
 * (Backlighting `bl_projects`, Linear Lighting `lld_project`).
 *
 * Medusa es el DUEÑO de la relación orden↔proyecto y de este candado: lo
 * escribe el subscriber `project-order-lock` (mismos eventos que el auto-cierre
 * de órdenes) y el reconciler `project-order-lock-reconciler` (cada 5 min,
 * tomando el vínculo desde los DOS lados: `order.metadata.*_project_id` y
 * `estimate_id` del proyecto). Las apps sólo lo LEEN, por SQL directo —
 * comparten esta Postgres— y contestan 409 `project_locked` en cada escritura.
 *
 * Predicado (el mismo que bloquea el sync del BOM en el POS,
 * `orderSyncBlockReason`): la orden recibió al menos un centavo
 * (`order_money_projection.received_cents`, aplicado + depósito, o el capturado
 * nativo) → `paid`; o entregó unidades → `fulfilled`. Un estimate (draft order)
 * nunca lockea.
 *
 * PK (app, project_id): un proyecto se ata a UNA orden. `unlocked_at` existe
 * para un desbloqueo manual con rastro (no hay ruta que lo haga: es SQL de
 * operador); mientras sea NULL el candado rige. `facts` guarda los números
 * con los que se decidió, para auditar sin recalcular.
 *
 * Expand-only: crear la tabla no toca ninguna fila existente. Kill switch de
 * runtime: PROJECT_LOCK_DISABLED=true apaga subscriber y reconciler.
 */
export class CreateProjectOrderLock1789100000000 implements MigrationInterface {
  name = "CreateProjectOrderLock1789100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS project_order_lock (
        app         TEXT        NOT NULL,
        project_id  TEXT        NOT NULL,
        order_id    TEXT        NOT NULL,
        reason      TEXT        NOT NULL,
        locked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        unlocked_at TIMESTAMPTZ NULL,
        created_by  TEXT        NOT NULL,
        facts       JSONB       NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT project_order_lock_pkey PRIMARY KEY (app, project_id),
        CONSTRAINT project_order_lock_app_chk
          CHECK (app IN ('backlighting', 'linear-lighting')),
        CONSTRAINT project_order_lock_reason_chk
          CHECK (reason IN ('paid', 'fulfilled'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_project_order_lock_order
        ON project_order_lock (order_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS project_order_lock`);
  }
}
