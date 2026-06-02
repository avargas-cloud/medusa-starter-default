import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Close the last MeiliSearch reservation-sync gap.
 *
 * The `inventory_level` trigger (1779200000000) covers stock + the cached
 * `reserved_quantity` column — but it only fires when `inventory_level` itself
 * is written. Reservation flows that mutate `reservation_item` via RAW SQL
 * without touching `inventory_level.reserved_quantity` (some fix scripts, and
 * any future direct write) would NOT enqueue a Meili sync, leaving
 * `totalReserved` stale until an unrelated stock movement happened.
 *
 * This adds a row trigger on `reservation_item` that reuses the existing
 * `enqueue_meili_sync_inventory_item()` function (reservation_item has an
 * `inventory_item_id` column, exactly what the function reads). Now ANY
 * reservation create / update / delete — by Medusa module, workflow, or raw
 * SQL — enqueues the affected `inventory_item_id` for a full doc rebuild.
 *
 * op is ALWAYS 'UPDATE' (the function hardcodes it): deleting a reservation
 * must re-sync the item's CURRENT state, never delete the inventory doc.
 *
 * Together with 1779200000000 this guarantees: every inventory AND reservation
 * change, regardless of writer, reaches MeiliSearch within ~1 minute.
 */
export class AddReservationItemMeiliSyncTrigger1779300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Reuses enqueue_meili_sync_inventory_item() created in 1779200000000.
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_meili_sync_reservation_item ON reservation_item
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_reservation_item
      AFTER INSERT OR UPDATE OR DELETE ON reservation_item
      FOR EACH ROW EXECUTE FUNCTION enqueue_meili_sync_inventory_item()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_meili_sync_reservation_item ON reservation_item`
    );
  }
}
