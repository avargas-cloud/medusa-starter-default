/**
 * Backfill: move every `purchase_order.tracking` JSON entry into the shipment
 * tables (purchase_order_tracking + purchase_order_tracking_number).
 *
 * ── What it produces, and why that shape ─────────────────────────────────────
 * ONE shipment per purchase order, scope `all_order`, carrying every JSON entry
 * of that PO as a tracking NUMBER — first one master.
 *
 * That is not an interpretation. The old JSON column had no concept of scope or
 * of a delivery: every entry said "this number belongs to this PO" and nothing
 * more. Several entries on one PO have therefore always meant "this delivery
 * has several numbers" — the only reading under which the data is consistent.
 * Modelling them as separate deliveries would assert that each one contains all
 * of the goods, which cannot be true of more than one, and the write path now
 * refuses to create that combination anyway.
 *
 * `all_order` with no allocations is likewise the honest translation: the JSON
 * never recorded which goods a number carried, so claiming any quantity here
 * would be inventing data. The operator splits it later by editing the shipment
 * and marking what actually arrived.
 *
 * ── Idempotent by construction ───────────────────────────────────────────────
 * Ids are DERIVED from the legacy entry ids — the shipment takes the first
 * entry's id, each number takes `potrkn_<entry id>`. So a second run finds them
 * present and skips, and a run after a partial failure resumes instead of
 * duplicating. The check is a real SELECT of existing ids, not a "have I run
 * before" flag.
 *
 * The JSON column is NOT cleared. It stays as the rollback path for one
 * release; dropping it is a separate, later decision.
 *
 * Dry-run by default. Apply with DRY_RUN=false.
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     npx medusa exec ./src/scripts/fix/backfill-po-tracking-to-tables.ts
 */

import type { TrackingEntry } from "../../lib/carrier-tracking/types";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
};

interface PoRow {
  id: string;
  number: string | null;
  tracking: unknown;
}

/** Carrier statuses the table's CHECK constraint accepts. */
const VALID_STATUSES = [
  "pending",
  "in_transit",
  "delivered",
  "unavailable",
  "error",
];

/** ISO date guard — the column is text, so a malformed value would survive. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseEntries(raw: unknown): TrackingEntry[] {
  if (Array.isArray(raw)) return raw as TrackingEntry[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TrackingEntry[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export default async function run({
  container,
}: {
  container: { resolve: (k: string) => unknown };
}): Promise<void> {
  const dry = process.env.DRY_RUN !== "false"; // default = dry-run
  const db = container.resolve("__pg_connection__") as Knex;

  const pos = (
    await db.raw(
      `SELECT id, number, tracking
         FROM purchase_order
        WHERE deleted_at IS NULL
          AND tracking IS NOT NULL
        ORDER BY created_at, id`
    )
  ).rows as PoRow[];

  // One read of what already landed — this is what makes a re-run a resume.
  const existingShipments = new Set(
    (
      (await db.raw(`SELECT id FROM purchase_order_tracking`)).rows as Array<{
        id: string;
      }>
    ).map((r) => r.id)
  );
  const existingNumbers = new Set(
    (
      (
        await db.raw(`SELECT id FROM purchase_order_tracking_number`)
      ).rows as Array<{ id: string }>
    ).map((r) => r.id)
  );

  interface PlannedShipment {
    id: string;
    poId: string;
    poNumber: string | null;
    numbers: TrackingEntry[];
  }

  const planned: PlannedShipment[] = [];
  let malformed = 0;
  let skippedShipments = 0;

  for (const po of pos) {
    const entries = parseEntries(po.tracking).filter((e) => {
      const ok = Boolean(e?.id && e.tracking_number && e.provider);
      if (!ok) malformed++;
      return ok;
    });
    if (entries.length === 0) continue;

    const shipmentId = entries[0].id;
    if (existingShipments.has(shipmentId)) {
      skippedShipments++;
      continue;
    }
    planned.push({
      id: shipmentId,
      poId: po.id,
      poNumber: po.number,
      numbers: entries,
    });
  }

  const totalNumbers = planned.reduce((n, s) => n + s.numbers.length, 0);
  const multi = planned.filter((s) => s.numbers.length > 1);
  const label = dry ? "[DRY-RUN]" : "[APPLIED]";

  process.stdout.write(
    `\n${label} POs with tracking JSON: ${pos.length}\n` +
      `${label} shipments to create: ${planned.length} (carrying ${totalNumbers} number(s))\n` +
      `${label} already present: ${skippedShipments} · malformed entries skipped: ${malformed}\n`
  );

  if (multi.length > 0) {
    process.stdout.write(
      `${label} ${multi.length} PO(s) whose numbers collapse into ONE delivery:\n`
    );
    for (const s of multi.slice(0, 10)) {
      const nums = s.numbers.map((n, i) => `${n.tracking_number}${i === 0 ? "*" : ""}`);
      process.stdout.write(
        `          ${s.poNumber ?? s.poId}: ${nums.join(", ")}   (* = master)\n`
      );
    }
    if (multi.length > 10) {
      process.stdout.write(`          … and ${multi.length - 10} more\n`);
    }
  }

  if (dry) {
    process.stdout.write(
      "[DRY-RUN] nothing written. Re-run with DRY_RUN=false to apply.\n\n"
    );
    return;
  }
  if (planned.length === 0) {
    process.stdout.write("[APPLIED] nothing to do.\n\n");
    return;
  }

  let doneShipments = 0;
  let doneNumbers = 0;

  for (const shipment of planned) {
    await db.raw(
      `INSERT INTO purchase_order_tracking
         (id, purchase_order_id, scope, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'all_order', ?, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [shipment.id, shipment.poId, shipment.numbers[0].created_by_user_id ?? null]
    );
    doneShipments++;

    for (const [i, entry] of shipment.numbers.entries()) {
      const numberId = `potrkn_${entry.id}`;
      if (existingNumbers.has(numberId)) continue;

      const status = VALID_STATUSES.includes(entry.carrier_status ?? "")
        ? entry.carrier_status
        : "pending";
      const eta =
        entry.carrier_eta && ISO_DATE.test(entry.carrier_eta.slice(0, 10))
          ? entry.carrier_eta.slice(0, 10)
          : null;

      await db.raw(
        `INSERT INTO purchase_order_tracking_number
           (id, purchase_order_tracking_id, purchase_order_id, provider,
            tracking_number, tracking_url, is_master, carrier_eta, carrier_status,
            carrier_eta_fetched_at, carrier_detail, created_by_user_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), now())
         ON CONFLICT (id) DO NOTHING`,
        [
          numberId,
          shipment.id,
          shipment.poId,
          entry.provider,
          entry.tracking_number,
          entry.tracking_url ?? "",
          i === 0, // the first entry becomes the master
          eta,
          status,
          entry.carrier_eta_fetched_at ?? null,
          entry.carrier_detail ?? null,
          entry.created_by_user_id ?? null,
        ]
      );
      doneNumbers++;
    }

    if (doneShipments % 50 === 0) {
      process.stdout.write(`[APPLIED] ${doneShipments}/${planned.length}\n`);
    }
  }

  process.stdout.write(
    `\n[APPLIED] done — ${doneShipments} delivery(ies) carrying ${doneNumbers} ` +
      `tracking number(s), all scope='all_order'. The JSON column was left untouched.\n` +
      `[APPLIED] Verify with: npx medusa exec ./src/scripts/verify/verify-po-tracking-allocations.ts\n\n`
  );
}
