import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Estado del InventoryAdjustment de defectuosos de un credit memo.
 *
 * Un credit memo posee UN ajuste de inventario en QuickBooks durante toda su
 * vida: nace cuando alguna línea tiene `damaged_qty > 0` y después se EDITA
 * (InventoryAdjustmentMod) cada vez que esas cantidades cambian. Nunca se crea
 * un segundo documento — igual que el propio credit memo, que se crea una vez
 * y después va por `credit_memo_mod`.
 *
 * Por eso el estado son campos escalares en la cabecera y no una tabla de
 * revisiones: no hay N documentos que reconciliar, hay uno.
 *
 * Las tres columnas se llenan JUNTAS al confirmar el Add y vuelven a NULL
 * juntas al voidear el ajuste (todas las líneas dejaron de tener defectuosos,
 * o se voideó el credit memo). Un `txn_id` sin `edit_sequence` no sirve para
 * nada: todo Mod de QuickBooks exige las dos.
 *
 * `qb_adjustment_txn_line_id` en la línea es la identidad de esa línea DENTRO
 * del ajuste — no confundir con `qb_txn_line_id`, que es su identidad dentro
 * del credit memo. Son dos documentos distintos de QuickBooks y sus TxnLineID
 * no tienen relación.
 */
export class Migration20260812190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "pos_credit_memo" add column if not exists "qb_inventory_adjustment_txn_id" text null;`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo" add column if not exists "qb_inventory_adjustment_ref" text null;`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo" add column if not exists "qb_inventory_adjustment_edit_sequence" text null;`
    );

    this.addSql(
      `alter table if exists "pos_credit_memo_item" add column if not exists "qb_adjustment_txn_line_id" text null;`
    );

    // Parcial: la enorme mayoría de los credit memos no tiene defectuosos y
    // deja las columnas en NULL. El índice sirve para resolver "¿qué credit
    // memo es dueño de este ajuste?" al reconciliar contra QuickBooks.
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_pos_credit_memo_qb_inv_adj_txn_id" ON "pos_credit_memo" ("qb_inventory_adjustment_txn_id") WHERE "qb_inventory_adjustment_txn_id" IS NOT NULL;`
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `DROP INDEX IF EXISTS "IDX_pos_credit_memo_qb_inv_adj_txn_id";`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo_item" drop column if exists "qb_adjustment_txn_line_id";`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo" drop column if exists "qb_inventory_adjustment_edit_sequence";`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo" drop column if exists "qb_inventory_adjustment_ref";`
    );
    this.addSql(
      `alter table if exists "pos_credit_memo" drop column if exists "qb_inventory_adjustment_txn_id";`
    );
  }
}
