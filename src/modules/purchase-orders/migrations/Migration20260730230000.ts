import { Migration } from "@mikro-orm/migrations";

/**
 * A delivery and a tracking number are not the same thing (2026-07-30).
 *
 * The previous migration put the carrier number ON the shipment row, one per
 * row. But one delivery routinely produces several numbers — two FedEx waybills
 * for the same truck, a freight booking plus its house bill. Modelling those as
 * two shipments makes them two competing claims on the same goods, which is
 * exactly the contradiction the scope rules exist to prevent: a purchase order
 * is EITHER covered by one whole-PO delivery OR broken out per item, never both
 * and never two whole-PO ones. Two waybills for one truck are not two
 * deliveries; they are two labels on one.
 *
 * So the numbers move to their own table and the shipment keeps only what it
 * genuinely owns: which PO it belongs to and what it carries.
 *
 *   purchase_order_tracking         the SHIPMENT: what is arriving (scope)
 *   purchase_order_tracking_number  the carrier numbers naming it (1..N)
 *   purchase_order_tracking_line    which PO lines and how many units
 *
 * The first number is the MASTER — the one a document quotes when it has room
 * for exactly one.
 *
 * ── The merge, and why it is not a guess ─────────────────────────────────────
 * Purchase orders that came out of the JSON import carrying several whole-PO
 * rows are collapsed into ONE shipment holding all their numbers, oldest first
 * as master. That is not an interpretation: the old JSON column had no concept
 * of scope, so every entry in it said "this number belongs to this PO" and
 * nothing more. Several such entries on one PO have always meant "this delivery
 * has several numbers" — the only reading under which the data is consistent.
 * Leaving them as separate shipments would instead assert that each delivery
 * contains all of the goods, which cannot be true of more than one.
 *
 * Shipments that already carry allocations are never merged: those said
 * something specific about quantities and must be preserved exactly.
 *
 * Forward-only by design. `down()` puts the columns back and restores the
 * master number onto each shipment, which is lossless for any PO that never
 * gained a second number; a PO that did would lose the extras, and that is
 * stated rather than hidden.
 */
export class Migration20260730230000 extends Migration {
  async up(): Promise<void> {
    // ── 1. The numbers get their own table ───────────────────────────────────
    this.addSql(`
      create table if not exists "purchase_order_tracking_number" (
        "id"                            text not null,
        "purchase_order_tracking_id"    text not null,
        "purchase_order_id"             text not null,
        "provider"                      text not null,
        "tracking_number"               text not null,
        "tracking_url"                  text not null default '',
        "is_master"                     boolean not null default false,
        "carrier_eta"                   text null,
        "carrier_status"                text not null default 'pending'
          check ("carrier_status" in ('pending','in_transit','delivered','unavailable','error')),
        "carrier_eta_fetched_at"        timestamptz null,
        "carrier_detail"                text null,
        "created_by_user_id"            text null,
        "created_at"                    timestamptz not null default now(),
        "updated_at"                    timestamptz not null default now(),
        "deleted_at"                    timestamptz null,
        constraint "purchase_order_tracking_number_pkey" primary key ("id"),
        constraint "FK_potrkn_tracking_id"
          foreign key ("purchase_order_tracking_id") references "purchase_order_tracking" ("id") on delete cascade,
        constraint "FK_potrkn_purchase_order_id"
          foreign key ("purchase_order_id") references "purchase_order" ("id") on delete cascade
      );
    `);

    // ── 2. Move every existing row's carrier data into it ────────────────────
    // `potrkn_` + the shipment id keeps this deterministic: re-running against a
    // partially migrated database cannot mint a second copy.
    this.addSql(`
      insert into "purchase_order_tracking_number"
        (id, purchase_order_tracking_id, purchase_order_id, provider,
         tracking_number, tracking_url, is_master, carrier_eta, carrier_status,
         carrier_eta_fetched_at, carrier_detail, created_by_user_id,
         created_at, updated_at, deleted_at)
      select 'potrkn_' || trk.id,
             trk.id,
             trk.purchase_order_id,
             trk.provider,
             trk.tracking_number,
             coalesce(trk.tracking_url, ''),
             true,
             trk.carrier_eta,
             trk.carrier_status,
             trk.carrier_eta_fetched_at,
             trk.carrier_detail,
             trk.created_by_user_id,
             trk.created_at,
             trk.updated_at,
             trk.deleted_at
        from "purchase_order_tracking" trk
       where not exists (
             select 1 from "purchase_order_tracking_number" n
              where n.id = 'potrkn_' || trk.id);
    `);

    // ── 3. Collapse sibling whole-PO shipments into one ──────────────────────
    // Oldest survives and keeps its master; the others hand over their numbers
    // as non-master and are removed. Shipments carrying allocations are left
    // alone — they made a specific claim about quantities.
    this.addSql(`
      with keeper as (
        select purchase_order_id,
               (array_agg(id order by created_at, id))[1] as keep_id
          from "purchase_order_tracking"
         where deleted_at is null
           and scope = 'all_order'
           and not exists (
                 select 1 from "purchase_order_tracking_line" l
                  where l.purchase_order_tracking_id = "purchase_order_tracking".id
                    and l.deleted_at is null)
         group by purchase_order_id
        having count(*) > 1
      )
      update "purchase_order_tracking_number" n
         set purchase_order_tracking_id = k.keep_id,
             is_master = false,
             updated_at = now()
        from keeper k, "purchase_order_tracking" trk
       where n.purchase_order_tracking_id = trk.id
         and trk.purchase_order_id = k.purchase_order_id
         and trk.id <> k.keep_id
         and trk.deleted_at is null
         and trk.scope = 'all_order';
    `);
    this.addSql(`
      with keeper as (
        select purchase_order_id,
               (array_agg(id order by created_at, id))[1] as keep_id
          from "purchase_order_tracking"
         where deleted_at is null and scope = 'all_order'
         group by purchase_order_id
        having count(*) > 1
      )
      delete from "purchase_order_tracking" trk
       using keeper k
       where trk.purchase_order_id = k.purchase_order_id
         and trk.id <> k.keep_id
         and trk.deleted_at is null
         and trk.scope = 'all_order'
         and not exists (
               select 1 from "purchase_order_tracking_number" n
                where n.purchase_order_tracking_id = trk.id
                  and n.deleted_at is null);
    `);

    // ── 4. Constraints and indexes ───────────────────────────────────────────
    // Exactly one master per shipment: none leaves it nameless, two make the
    // name ambiguous.
    this.addSql(
      `create unique index if not exists "UQ_potrkn_one_master" on "purchase_order_tracking_number" ("purchase_order_tracking_id") where "is_master" and "deleted_at" is null;`
    );
    this.addSql(
      `create unique index if not exists "UQ_potrkn_number_per_shipment" on "purchase_order_tracking_number" ("purchase_order_tracking_id", "provider", "tracking_number") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_potrkn_tracking_id" on "purchase_order_tracking_number" ("purchase_order_tracking_id") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_potrkn_purchase_order_id" on "purchase_order_tracking_number" ("purchase_order_id") where "deleted_at" is null;`
    );
    // Drives the cron's dedup: one carrier call per (provider, number), even
    // when the same number names deliveries on several purchase orders.
    this.addSql(
      `create index if not exists "IDX_potrkn_number" on "purchase_order_tracking_number" ("provider", "tracking_number") where "deleted_at" is null;`
    );
    this.addSql(
      `create index if not exists "IDX_potrkn_deleted_at" on "purchase_order_tracking_number" ("deleted_at") where "deleted_at" is null;`
    );

    // ── 5. The shipment keeps only what it owns ──────────────────────────────
    this.addSql(`
      alter table "purchase_order_tracking"
        drop constraint if exists "purchase_order_tracking_carrier_status_check";
    `);
    for (const col of [
      "provider",
      "tracking_number",
      "tracking_url",
      "carrier_eta",
      "carrier_status",
      "carrier_eta_fetched_at",
      "carrier_detail",
    ]) {
      this.addSql(
        `alter table "purchase_order_tracking" drop column if exists "${col}";`
      );
    }
  }

  async down(): Promise<void> {
    this.addSql(`
      alter table "purchase_order_tracking"
        add column if not exists "provider" text not null default '',
        add column if not exists "tracking_number" text not null default '',
        add column if not exists "tracking_url" text not null default '',
        add column if not exists "carrier_eta" text null,
        add column if not exists "carrier_status" text not null default 'pending',
        add column if not exists "carrier_eta_fetched_at" timestamptz null,
        add column if not exists "carrier_detail" text null;
    `);
    // Restore the master number onto the shipment. A shipment that gained extra
    // numbers loses them here — forward-only by design, stated not hidden.
    this.addSql(`
      update "purchase_order_tracking" trk
         set provider = n.provider,
             tracking_number = n.tracking_number,
             tracking_url = n.tracking_url,
             carrier_eta = n.carrier_eta,
             carrier_status = n.carrier_status,
             carrier_eta_fetched_at = n.carrier_eta_fetched_at,
             carrier_detail = n.carrier_detail
        from "purchase_order_tracking_number" n
       where n.purchase_order_tracking_id = trk.id
         and n.is_master
         and n.deleted_at is null;
    `);
    this.addSql(`drop table if exists "purchase_order_tracking_number" cascade;`);
  }
}
