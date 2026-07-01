/**
 * scripts/migrations/backfill-china-finance-split-bills.ts
 *
 * One-time backfill (F1) for the "Partial #N" split-bill model. Converts every
 * china_finance_bill that is currently paid across MULTIPLE wire applications (or
 * partially paid with an unassigned remainder) into physical child rows — one
 * schedulable row per application, plus a remainder row for the unpaid balance —
 * so that after this runs every row is a single, independently-schedulable unit
 * (exactly one wire application per row).
 *
 * INVARIANT preserved (verified before/after): for every affected bill,
 *   Σ child.amount_cents == original bill.amount_cents
 * and globally total_expenses / total_covered / total_received / balance are
 * byte-identical. Applications are only RE-POINTED (bill_id), never re-valued.
 *
 * Model after run: the original row becomes Partial #1 (keeps id + vendor_bill_id
 * = root); siblings are new rows with vendor_bill_id NULL, split_group_id = root
 * id, partial_seq = 2..k. Overpayment (Σapplied > amount) reduces the last
 * confirmed child's amount (applied stays → credit).
 *
 * Env:
 *   DATABASE_URL   required (point at the SANDBOX 5499 for testing, never prod
 *                  without explicit intent).
 *   DRY_RUN=true   compute + print the plan, verify invariants, then ROLLBACK.
 *
 * Run:  env DATABASE_URL=... DRY_RUN=true npx ts-node src/scripts/migrations/backfill-china-finance-split-bills.ts
 *
 * Idempotent: only processes bills with split_group_id IS NULL that still need a
 * split; already-split groups are skipped, so re-runs are no-ops.
 */

import * as dotenv from "dotenv";
import { Client } from "pg";
import * as path from "path";
import { randomUUID } from "crypto";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const DRY_RUN = process.env.DRY_RUN === "true";

type AppRow = {
  app_id: string;
  wire_id: string;
  applied_cents: number;
  wire_status: string;
  wire_sent_date: string | null;
  app_sort_order: number;
};

type BillRow = {
  id: string;
  amount_cents: number;
  type: string;
  sort_order: number;
  document_type: string;
  invoice_number: string | null;
  po_number: string | null;
  po_ref_number: string | null;
  payee: string | null;
  description: string | null;
  document_date: string | null;
  due_date: string | null;
};

type Summary = {
  total_expenses_cents: number;
  total_covered_cents: number;
  total_received_cents: number;
  balance_cents: number;
};

async function readSummary(client: Client): Promise<Summary> {
  // ::bigint (returned as string by pg) → parse via Number to avoid int4 overflow
  // above ~$21.47M in cents.
  const { rows } = await client.query<{
    total_expenses_cents: string;
    total_covered_cents: string;
    total_received_cents: string;
  }>(`
    SELECT
      COALESCE(SUM(cfb.amount_cents), 0)::bigint AS total_expenses_cents,
      COALESCE((SELECT SUM(applied_cents) FROM china_wire_transfer_application), 0)::bigint AS total_covered_cents,
      COALESCE((SELECT SUM(received_amount_cents) FROM china_wire_transfer WHERE status = 'confirmed'), 0)::bigint AS total_received_cents
    FROM china_finance_bill cfb
  `);
  const s = rows[0];
  const total_expenses_cents = Number(s.total_expenses_cents);
  const total_covered_cents = Number(s.total_covered_cents);
  const total_received_cents = Number(s.total_received_cents);
  return {
    total_expenses_cents,
    total_covered_cents,
    total_received_cents,
    balance_cents: total_received_cents - total_expenses_cents,
  };
}

/** Bills that need a physical split: >1 application, OR a single application that
 *  does not fully cover the bill (leaves an unassigned remainder). A single
 *  application with applied >= amount is a single unit already (overpay allowed),
 *  so it is left un-split. */
async function loadCandidates(client: Client): Promise<BillRow[]> {
  const { rows } = await client.query<BillRow>(`
    SELECT cfb.id, cfb.amount_cents, cfb.type, cfb.sort_order, cfb.document_type,
           cfb.invoice_number, cfb.po_number, cfb.po_ref_number, cfb.payee,
           cfb.description, cfb.document_date::text, cfb.due_date::text
    FROM china_finance_bill cfb
    JOIN (
      SELECT bill_id,
             COUNT(*) AS app_count,
             SUM(applied_cents)::int AS sum_applied
      FROM china_wire_transfer_application
      GROUP BY bill_id
    ) a ON a.bill_id = cfb.id
    WHERE cfb.split_group_id IS NULL
      AND cfb.type <> 'bank_fee'
      AND cfb.document_type <> 'opening_balance'
      AND (a.app_count > 1 OR a.sum_applied < cfb.amount_cents)
    ORDER BY cfb.sort_order ASC
  `);
  return rows;
}

async function loadApps(client: Client, billId: string): Promise<AppRow[]> {
  const { rows } = await client.query<AppRow>(
    `SELECT cwta.id AS app_id, cwta.wire_transfer_id AS wire_id,
            cwta.applied_cents, cwt.status AS wire_status,
            cwt.sent_date::text AS wire_sent_date, cwta.sort_order AS app_sort_order
     FROM china_wire_transfer_application cwta
     JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
     WHERE cwta.bill_id = $1
     ORDER BY cwt.sent_date ASC NULLS LAST, cwta.sort_order ASC, cwta.id ASC`,
    [billId]
  );
  return rows;
}

async function splitBill(client: Client, bill: BillRow): Promise<number> {
  const apps = await loadApps(client, bill.id);
  const sumApplied = apps.reduce((n, a) => n + a.applied_cents, 0);

  // Each application becomes one child (amount = its applied). Then reconcile the
  // group total back to the original bill amount.
  const children = apps.map((a) => ({ app: a, amount: a.applied_cents }));
  const diff = bill.amount_cents - sumApplied;
  let remainderAmount = 0;
  if (diff > 0) {
    remainderAmount = diff; // unassigned remainder child
  } else if (diff < 0) {
    // Overpayment (Σapplied > amount): the group total must equal the bill
    // amount, so reduce child amounts (applied stays → confirmed credit). Absorb
    // the overpay across children in reverse, CONFIRMED first (their amount<applied
    // is the legit credit), cascading to others if one child cannot hold it all;
    // never below 0. A draft child ending amount<applied is a data anomaly → warn.
    let overpay = -diff;
    const order = children
      .map((_, i) => i)
      .sort((x, y) => {
        const cx = children[x].app.wire_status === "confirmed" ? 0 : 1;
        const cy = children[y].app.wire_status === "confirmed" ? 0 : 1;
        return cx - cy || y - x; // confirmed first, then higher seq first
      });
    for (const idx of order) {
      if (overpay <= 0) break;
      const take = Math.min(children[idx].amount, overpay);
      children[idx].amount -= take;
      overpay -= take;
      if (children[idx].app.wire_status !== "confirmed" && children[idx].amount < children[idx].app.applied_cents) {
        console.warn(`  ⚠ bill ${bill.id}: DRAFT child on wire ${children[idx].app.wire_id} reduced below its applied — inspect (over-scheduled draft).`);
      }
    }
    if (overpay > 0) {
      throw new Error(`bill ${bill.id}: overpay ${(-diff)}¢ exceeds Σ child amounts — corrupt data, manual review needed`);
    }
  }

  const totalChildAmounts =
    children.reduce((n, c) => n + c.amount, 0) + remainderAmount;
  if (totalChildAmounts !== bill.amount_cents) {
    throw new Error(
      `split invariant broken for bill ${bill.id}: Σchildren ${totalChildAmounts} != amount ${bill.amount_cents}`
    );
  }

  const rootId = bill.id;
  let seq = 0;
  let rowsWritten = 0;

  for (let i = 0; i < children.length; i++) {
    seq += 1;
    const c = children[i];
    const wireTransferId = c.app.wire_status === "confirmed" ? c.app.wire_id : null;
    if (i === 0) {
      // Original row becomes Partial #1 (anchor / root). Recompute amount + FK.
      await client.query(
        `UPDATE china_finance_bill
           SET amount_cents = $1, split_group_id = $2, partial_seq = 1,
               split_version = split_version + 1, wire_transfer_id = $3,
               updated_at = now()
         WHERE id = $2`,
        [c.amount, rootId, wireTransferId]
      );
    } else {
      const childId = randomUUID();
      await client.query(
        `INSERT INTO china_finance_bill
           (id, type, sort_order, vendor_bill_id, wire_transfer_id, document_type,
            invoice_number, po_number, po_ref_number, payee, description,
            amount_cents, document_date, due_date, split_group_id, partial_seq,
            split_version)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0)`,
        [childId, bill.type, bill.sort_order, wireTransferId, bill.document_type,
         bill.invoice_number, bill.po_number, bill.po_ref_number, bill.payee,
         bill.description, c.amount, bill.document_date, bill.due_date, rootId, seq]
      );
      // Re-point this application to the new child (one app per row).
      await client.query(
        `UPDATE china_wire_transfer_application SET bill_id = $1, updated_at = now() WHERE id = $2`,
        [childId, c.app.app_id]
      );
      rowsWritten += 1;
    }
  }

  if (remainderAmount > 0) {
    seq += 1;
    const childId = randomUUID();
    await client.query(
      `INSERT INTO china_finance_bill
         (id, type, sort_order, vendor_bill_id, wire_transfer_id, document_type,
          invoice_number, po_number, po_ref_number, payee, description,
          amount_cents, document_date, due_date, split_group_id, partial_seq,
          split_version)
       VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0)`,
      [childId, bill.type, bill.sort_order, bill.document_type, bill.invoice_number,
       bill.po_number, bill.po_ref_number, bill.payee, bill.description,
       remainderAmount, bill.document_date, bill.due_date, rootId, seq]
    );
    rowsWritten += 1;
  }

  console.log(
    `  · bill ${bill.id} (${bill.invoice_number ?? "—"}): amount ${bill.amount_cents}¢ → ${seq} partials ` +
      `[${children.map((c) => c.amount).join(" + ")}${remainderAmount > 0 ? ` + ${remainderAmount}(rem)` : ""}]`
  );
  return rowsWritten;
}

/** Structural invariants that must hold AFTER the backfill. Throws on violation. */
async function verifyStructure(client: Client): Promise<void> {
  // 1. One application per row (UNIQUE(bill_id) backstop will be added next).
  const dupApps = await client.query(
    `SELECT bill_id, COUNT(*) c FROM china_wire_transfer_application GROUP BY bill_id HAVING COUNT(*) > 1`
  );
  if (dupApps.rows.length > 0) {
    throw new Error(`still ${dupApps.rows.length} bill(s) with >1 application — UNIQUE(bill_id) not satisfiable`);
  }
  // 2. partial_seq contiguous 1..k and a root row (partial_seq=1 with id == group id).
  const badGroups = await client.query(`
    SELECT g.split_group_id
    FROM china_finance_bill g
    WHERE g.split_group_id IS NOT NULL
    GROUP BY g.split_group_id
    HAVING COUNT(*) <> MAX(g.partial_seq) OR MIN(g.partial_seq) <> 1
  `);
  if (badGroups.rows.length > 0) {
    throw new Error(`non-contiguous partial_seq in ${badGroups.rows.length} group(s)`);
  }
  const noRoot = await client.query(`
    SELECT sg FROM (
      SELECT DISTINCT split_group_id AS sg FROM china_finance_bill WHERE split_group_id IS NOT NULL
    ) grp
    WHERE NOT EXISTS (
      SELECT 1 FROM china_finance_bill r
      WHERE r.id = grp.sg AND r.split_group_id = grp.sg AND r.partial_seq = 1
    )
  `);
  if (noRoot.rows.length > 0) {
    throw new Error(`${noRoot.rows.length} group(s) missing root anchor (id == split_group_id, partial_seq=1)`);
  }
  // 3. Every split group's Σ child amount is a positive int and each row amount >= 0
  //    (CHECK already enforces >=0; this catches a group that summed to 0 unexpectedly).
  const zeroGroups = await client.query(`
    SELECT split_group_id FROM china_finance_bill
    WHERE split_group_id IS NOT NULL
    GROUP BY split_group_id HAVING SUM(amount_cents) = 0
  `);
  if (zeroGroups.rows.length > 0) {
    console.warn(`  ⚠ ${zeroGroups.rows.length} split group(s) sum to 0 — verify these are intentional.`);
  }
  // 4. Re-running the candidate query must now yield zero actionable candidates.
  const leftover = await loadCandidates(client);
  if (leftover.length > 0) {
    throw new Error(`${leftover.length} candidate(s) still match after backfill — not idempotent-complete`);
  }
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log(`China Finance split-bill backfill — DRY_RUN=${DRY_RUN} — db=${(process.env.DATABASE_URL ?? "").replace(/:[^:@/]*@/, ":***@")}`);

  try {
    await client.query("BEGIN");
    // Isolate from concurrent writers (GET /bills auto-sync, reassign, wire create).
    // EXCLUSIVE blocks writes but still allows plain SELECT readers. Advisory lock
    // prevents two backfills racing. Run in a maintenance window regardless.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('china_finance_split_backfill'))`);
    await client.query(
      `LOCK TABLE china_finance_bill, china_wire_transfer_application, china_wire_transfer IN EXCLUSIVE MODE`
    );
    const before = await readSummary(client);
    console.log("BEFORE:", before);

    const candidates = await loadCandidates(client);
    console.log(`Found ${candidates.length} bill(s) to split.`);

    let rows = 0;
    for (const bill of candidates) rows += await splitBill(client, bill);

    const after = await readSummary(client);
    console.log("AFTER: ", after);

    const keys: (keyof Summary)[] = [
      "total_expenses_cents", "total_covered_cents", "total_received_cents", "balance_cents",
    ];
    const drift = keys.filter((k) => before[k] !== after[k]);
    if (drift.length > 0) {
      throw new Error(`BALANCE DRIFT on ${drift.join(", ")} — before/after mismatch, aborting`);
    }
    await verifyStructure(client);
    console.log(`✅ invariants hold · ${candidates.length} bills split · ${rows} child rows created · balance unchanged`);

    if (DRY_RUN) {
      await client.query("ROLLBACK");
      console.log("DRY_RUN — rolled back, no changes persisted.");
    } else {
      // Data is now one-application-per-row: safe to add the UNIQUE backstops.
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cwta_bill_once ON china_wire_transfer_application(bill_id)`);
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cwta_wire_bill ON china_wire_transfer_application(wire_transfer_id, bill_id)`);
      await client.query("COMMIT");
      console.log("✅ committed + UNIQUE(bill_id) / UNIQUE(wire,bill) backstops created.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("❌ rolled back:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
