import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Migration20260626000001 (era Migration20260626000000, renombrada el 09/16/2026)
 *
 * Adds `resulted_negative` to inventory_count_line.
 *
 * POR QUÉ se renombró: MikroORM registra las migraciones de TODOS los módulos
 * en una sola tabla `mikro_orm_migrations`, por NOMBRE. `@medusajs/cart` 2.18
 * trae una `Migration20260626000000` (agrega `data` a `cart_line_item_tax_line`
 * y `cart_shipping_method_tax_line`); como la nuestra ya estaba registrada con
 * ese nombre, la del cart se dio por ejecutada y NUNCA corrió — en producción
 * ningún visitante pudo agregar al carrito desde el deploy de 2.18 (09/12) hasta
 * el 09/16, cuando se aplicaron las dos columnas a mano. Con el nombre nuevo,
 * ésta vuelve a correr (idempotente, no-op) y la del cart deja de estar tapada.
 * Gate: src/scripts/verify/verify-migration-name-collisions.ts
 *
 * Part of the delta-invariant approval rework: the approval flow no longer
 * blocks lines whose delta would drive on-hand negative (a unit can be sold
 * before its PO receipt is recorded; QB Desktop permits negative inventory).
 * Instead the line is applied and `resulted_negative=true` flags it so a
 * persistent (non-self-healing) negative can be reviewed without halting the
 * count.
 */
export class Migration20260626000001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line"
         add column if not exists "resulted_negative" boolean not null default false;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table "inventory_count_line"
         drop column if exists "resulted_negative";`
    );
  }
}
