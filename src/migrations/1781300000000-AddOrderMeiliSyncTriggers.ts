import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Wire orders into the Capa-2 Meili sync queue.
 *
 * Orders were the ONE important entity whose index sync depended entirely on some
 * route remembering to emit an event. Products, variants, customers, inventory
 * levels, reservations, vendors, POs and FOs already had a row trigger feeding
 * meili_sync_queue and a reconciler draining it. On 2026-07-29 that gap produced
 * ~900 wrong documents: `POST /admin/finance/payments/:id/apply` moved money and
 * emitted nothing, so `effective_payment` stayed frozen at whatever it was before
 * the payment arrived and the Deposited filter returned 960 orders when 24 owed
 * anything. Nothing anywhere would have noticed.
 *
 * A row trigger fires regardless of the writer — routes, cron runners, psql, fix
 * scripts — so no callsite has to remember anything ever again.
 *
 * Five tables, because the document reads from all of them and four of them can
 * change it while leaving `order.updated_at` untouched:
 *
 *   order              → status, metadata (referential_deposit, pos_closed,
 *                        qb_sync_status, sales_rep, document_number), email
 *   order_summary      → the total. Missing totals were the root cause of every
 *                        payment bucket being wrong.
 *   order_item         → fulfilled quantities → fulfillment_status → is_open
 *   payment_collection → captured/refunded → effective_payment, is_unpaid
 *   fulfillment        → packed/shipped/delivered → is_open, is_closed
 *
 * `order` reuses the generic enqueue_meili_sync() (entity_id = NEW.id, which is
 * the doc id). The other four need the ORDER id, not their own: two carry it in a
 * column, two reach it through a link table. Hence three new functions.
 *
 * Volume, measured against production before shipping: ~19 distinct orders change
 * per day and ~254 queue rows, against 47,785 already accumulated across the other
 * entities. The queue processor dedups by entity id when draining, so repeated
 * line edits on one order cost rows, not repeated Meili writes.
 *
 * DELETE enqueues op='DELETE'. Correct for `order` — the row IS the document. For
 * the other four the order still exists, so they always enqueue an UPSERT of the
 * parent; the reconciler decides deletion by whether the order is still there.
 *
 * IMPORTANT (atomic ship): this migration MUST deploy together with the `order`
 * registration in meili-sync-queue-processor.ts RECONCILERS. If the trigger ships
 * first, enqueued rows get marked "no reconciler registered" and are lost.
 */
export class AddOrderMeiliSyncTriggers1781300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enqueues the parent order named by a column on the changed row.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enqueue_meili_order_by_column()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      DECLARE
        target text;
      BEGIN
        EXECUTE format('SELECT ($1).%I::text', TG_ARGV[0])
          INTO target USING COALESCE(NEW, OLD);
        IF target IS NOT NULL THEN
          INSERT INTO meili_sync_queue (entity_type, entity_id, op, source_hint)
          VALUES ('order', target, TG_OP, current_setting('application_name', true));
        END IF;
        RETURN COALESCE(NEW, OLD);
      END;
      $fn$
    `);

    // A payment collection does not know its order; the link table does.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enqueue_meili_order_via_payment_collection()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        INSERT INTO meili_sync_queue (entity_type, entity_id, op, source_hint)
        SELECT 'order', opc.order_id, TG_OP,
               current_setting('application_name', true)
          FROM order_payment_collection opc
         WHERE opc.payment_collection_id = COALESCE(NEW.id, OLD.id)
           AND opc.deleted_at IS NULL
           AND opc.order_id IS NOT NULL;
        RETURN COALESCE(NEW, OLD);
      END;
      $fn$
    `);

    // Same shape for fulfillments.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION enqueue_meili_order_via_fulfillment()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $fn$
      BEGIN
        INSERT INTO meili_sync_queue (entity_type, entity_id, op, source_hint)
        SELECT 'order', ofu.order_id, TG_OP,
               current_setting('application_name', true)
          FROM order_fulfillment ofu
         WHERE ofu.fulfillment_id = COALESCE(NEW.id, OLD.id)
           AND ofu.deleted_at IS NULL
           AND ofu.order_id IS NOT NULL;
        RETURN COALESCE(NEW, OLD);
      END;
      $fn$
    `);

    const triggers: Array<[string, string, string]> = [
      ["trg_meili_sync_order", '"order"', "enqueue_meili_sync('order')"],
      [
        "trg_meili_sync_order_summary",
        "order_summary",
        "enqueue_meili_order_by_column('order_id')",
      ],
      [
        "trg_meili_sync_order_item",
        "order_item",
        "enqueue_meili_order_by_column('order_id')",
      ],
      [
        "trg_meili_sync_order_payment_collection",
        "payment_collection",
        "enqueue_meili_order_via_payment_collection()",
      ],
      [
        "trg_meili_sync_order_fulfillment",
        "fulfillment",
        "enqueue_meili_order_via_fulfillment()",
      ],
    ];

    for (const [name, table, fn] of triggers) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await queryRunner.query(`
        CREATE TRIGGER ${name}
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION ${fn}
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name, table] of [
      ["trg_meili_sync_order", '"order"'],
      ["trg_meili_sync_order_summary", "order_summary"],
      ["trg_meili_sync_order_item", "order_item"],
      ["trg_meili_sync_order_payment_collection", "payment_collection"],
      ["trg_meili_sync_order_fulfillment", "fulfillment"],
    ]) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    }
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS enqueue_meili_order_by_column()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS enqueue_meili_order_via_payment_collection()`
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS enqueue_meili_order_via_fulfillment()`
    );
    // enqueue_meili_sync() is shared with the customer/product/vendor triggers —
    // never dropped here.
  }
}
