import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Wire `qb_vendor` into the Capa-2 Meili sync queue.
 *
 * Vendor→Meili sync was callsite-based, and only ONE of the six writers of
 * `qb_vendor` actually called it (`PUT /admin/qb-catalog/vendors/:id`). The
 * POS create route, `qb-vendor-sync-runner`, `qb-vendor-poller`,
 * `force-resync` and the pipeline retry route all wrote the row and left the
 * `vendors` index untouched — so the vendor existed in Postgres and was
 * INVISIBLE to `searchVendors` (Factory Order manufacturer picker, PO vendor
 * picker) forever. 20 vendors were missing when this shipped; the same class
 * of miss was already recorded on 2026-06-03 ("Fongkit", 1089 vs 1090).
 *
 * A row trigger fires regardless of the writer (routes, cron runners, psql,
 * fix scripts), so no callsite has to remember anything. `enqueue_meili_sync`
 * is the generic function already used by the customer/product triggers —
 * entity_id = NEW.id/OLD.id, which is exactly the Meili doc id for vendors.
 *
 * DELETE enqueues op='DELETE', which makes the queue processor delete the doc
 * — correct here, unlike inventory_level: a `qb_vendor` row IS the document.
 *
 * IMPORTANT (atomic ship): this migration MUST deploy together with the
 * `vendor` registration in meili-sync-queue-processor.ts RECONCILERS. If the
 * trigger ships first, enqueued rows get marked "no reconciler registered"
 * and are lost.
 */
export class AddVendorMeiliSyncTrigger1781200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_meili_sync_qb_vendor ON qb_vendor
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_meili_sync_qb_vendor
      AFTER INSERT OR UPDATE OR DELETE ON qb_vendor
      FOR EACH ROW EXECUTE FUNCTION enqueue_meili_sync('vendor')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS trg_meili_sync_qb_vendor ON qb_vendor`
    );
    // enqueue_meili_sync() is shared with the customer/product triggers — never
    // dropped here.
  }
}
