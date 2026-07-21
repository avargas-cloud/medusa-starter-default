/**
 * GET  /admin/china-finance/bills
 *   Returns all bills split into confirmed (grouped by wire) and pending sections.
 *   Auto-registers any new Veetech vendor bills not yet in china_finance_bill.
 *
 * POST /admin/china-finance/bills
 *   Creates a manual legacy bill entry.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";
import { applyBillTotalChange } from "../../../../lib/china-finance/bill-delta-engine";
import { describeDrift, loadBillDrift } from "../../../../lib/china-finance/bill-drift";

const VEETECH_VENDOR_ID = "qbvnd_01KPGGSG2J1BEEWQE5ET30AHFC";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

const createBillSchema = z.object({
  document_type: z.enum(["commercial_invoice", "purchasing_services", "shipping_cost"]),
  invoice_number: z.string().max(100).optional(),
  po_number: z.string().max(50).optional(),
  po_ref_number: z.string().max(50).optional(),
  payee: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  amount_cents: z.number().int().min(0),
  document_date: z.string().date().optional(),
  due_date: z.string().date().optional(),
});

// ── Auto-register new Veetech vendor bills ───────────────────────────────────
async function syncVeetchBills(knex: Knex): Promise<void> {
  // Keep Vendor Bill-linked finance rows aligned with the bill header.
  // Amounts stay locked once a bill has been applied to a CONFIRMED wire (real
  // money moved), but a bill that is only on scheduled/draft wires must still
  // track its own line total — otherwise editing a draft bill's quantities
  // could not flow through to its finance row. Document dates always reflect
  // the bill's own invoice date.
  //
  // Group-aware amount sync (F3): for each Veetech vendor bill whose line total
  // no longer matches its split-group total, route the change through the shared
  // delta engine. The engine owns ALL amount/wire mutation (split creation on a
  // confirmed-locked group, draft absorb, decrease cascade, collapse), so a
  // split root is never blindly reset to the full vendor total. `group_total` =
  // Σ amount of the split group (or the bill's own amount when un-split). Only
  // roots carry `vendor_bill_id`, so this selects one row per group.
  const { rows: changedGroupsRaw } = (await knex.raw(
    `WITH line_totals AS (
       SELECT vb.id AS vendor_bill_id,
              COALESCE((
                SELECT SUM(vbl.unit_cost_cents::bigint * vbl.qty)::integer
                FROM vendor_bill_line vbl
                WHERE vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
              ), 0) AS new_amount
       FROM vendor_bill vb
       WHERE vb.vendor_id = ?
         AND vb.bill_type IN ('regular','service','freight')
         AND vb.deleted_at IS NULL
     )
     SELECT cfb.id AS root_id, lt.new_amount,
            COALESCE((SELECT SUM(g.amount_cents)::integer FROM china_finance_bill g WHERE g.split_group_id = cfb.id),
                     cfb.amount_cents) AS group_total
     FROM china_finance_bill cfb
     JOIN line_totals lt ON lt.vendor_bill_id = cfb.vendor_bill_id
     WHERE cfb.type = 'vendor_bill' AND cfb.vendor_bill_id IS NOT NULL`,
    [VEETECH_VENDOR_ID]
  )) as { rows: Array<{ root_id: string; new_amount: number | string; group_total: number | string }> };

  for (const g of changedGroupsRaw) {
    // Coerce: pg returns bigint SUM as a string, so compare numerically.
    const newAmount = Number(g.new_amount);
    const groupTotal = Number(g.group_total);
    if (newAmount === groupTotal || !knex.transaction) continue;
    const trx = await knex.transaction();
    try {
      await applyBillTotalChange(trx, {
        billId: g.root_id,
        targetTotalCents: newAmount,
        source: "vendor_sync",
      });
      await trx.commit();
    } catch (e) {
      await trx.rollback();
      // A group not yet migrated (partial draft app) or otherwise guarded is
      // skipped, not corrupted; it syncs once the backfill/F3 split runs.
      console.warn(`[china-finance sync] amount sync skipped for ${g.root_id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  await knex.raw(
    `WITH vendor_bill_totals AS (
       SELECT
         vb.id,
         vb.reference_id,
         vb.bill_type,
         po.number AS po_ref_number,
         COALESCE(po.reference_number, po.qb_purchase_order_txn_number) AS po_number,
         COALESCE((
           SELECT SUM(vbl.unit_cost_cents::bigint * vbl.qty)::integer
           FROM vendor_bill_line vbl
           WHERE vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
         ), 0) AS amount_cents,
         COALESCE(vb.document_date::date, po.ordered_at::date) AS document_date,
         (COALESCE(vb.document_date::date, po.ordered_at::date) + INTERVAL '21 days')::date AS due_date
       FROM vendor_bill vb
       LEFT JOIN purchase_order po ON po.id = vb.purchase_order_id
       WHERE vb.vendor_id = ?
         AND vb.bill_type IN ('regular','service','freight')
         AND vb.deleted_at IS NULL
     )
     UPDATE china_finance_bill cfb
     SET
       invoice_number = vbt.reference_id,
       po_ref_number = vbt.po_ref_number,
       po_number = vbt.po_number,
       document_date = vbt.document_date,
       due_date = vbt.due_date
     FROM vendor_bill_totals vbt
     WHERE cfb.vendor_bill_id = vbt.id
       AND cfb.type = 'vendor_bill'`,
    [VEETECH_VENDOR_ID]
  );

  // Amount is NOT synced here anymore — the delta engine (above) owns it. Only
  // display metadata is refreshed. Propagate the root's metadata to its split
  // children (children have vendor_bill_id NULL so the join above skips them).
  await knex.raw(
    `UPDATE china_finance_bill child
        SET invoice_number = root.invoice_number,
            po_ref_number = root.po_ref_number,
            po_number = root.po_number,
            document_date = root.document_date,
            due_date = root.due_date,
            updated_at = now()
       FROM china_finance_bill root
      WHERE child.split_group_id = root.id
        AND child.id <> root.id
        AND root.vendor_bill_id IS NOT NULL
        AND (child.invoice_number IS DISTINCT FROM root.invoice_number
          OR child.po_ref_number IS DISTINCT FROM root.po_ref_number
          OR child.po_number IS DISTINCT FROM root.po_number
          OR child.document_date IS DISTINCT FROM root.document_date
          OR child.due_date IS DISTINCT FROM root.due_date)`
  );

  // Find confirmed/draft non-tariff Veetech VBs with no cfb record
  const { rows: unlinked } = await knex.raw(
    `SELECT
       vb.id, vb.reference_id, vb.bill_type,
       vb.number as vb_number,
       po.number as po_ref_number,
       COALESCE((
         SELECT SUM(vbl.unit_cost_cents::bigint * vbl.qty)::integer
         FROM vendor_bill_line vbl
         WHERE vbl.vendor_bill_id = vb.id AND vbl.deleted_at IS NULL
       ), 0) AS amount_cents,
       COALESCE(vb.document_date::date, po.ordered_at::date) AS document_date,
       (COALESCE(vb.document_date::date, po.ordered_at::date) + INTERVAL '21 days')::date AS due_date,
       COALESCE(po.reference_number, po.qb_purchase_order_txn_number) AS po_ext_number
     FROM vendor_bill vb
     LEFT JOIN purchase_order po ON po.id = vb.purchase_order_id
     WHERE vb.vendor_id = ?
       AND vb.bill_type IN ('regular','service','freight')
       AND vb.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM china_finance_bill cfb
         WHERE cfb.vendor_bill_id = vb.id
       )`,
    [VEETECH_VENDOR_ID]
  ) as { rows: Array<{
    id: string; reference_id: string | null; bill_type: string;
    vb_number: string | null; po_ref_number: string | null;
    amount_cents: number; document_date: string | null;
    due_date: string | null; po_ext_number: string | null;
  }> };

  if (unlinked.length === 0) return;

  const { rows: maxRow } = await knex.raw(
    `SELECT COALESCE(MAX(sort_order), 0) AS max_so FROM china_finance_bill`
  ) as { rows: [{ max_so: number }] };

  let nextSort = maxRow[0].max_so + 10;

  for (const vb of unlinked) {
    const docType =
      vb.bill_type === "regular" ? "commercial_invoice"
      : vb.bill_type === "service" ? "purchasing_services"
      : "shipping_cost";

    const payee =
      vb.bill_type === "regular" ? "COMMERCIAL INVOICE"
      : vb.bill_type === "service" ? "Purchasing Services"
      : "Shipping cost";

    await knex.raw(
      `INSERT INTO china_finance_bill
         (id, type, sort_order, vendor_bill_id, document_type,
          invoice_number, po_number, po_ref_number, payee, amount_cents,
          document_date, due_date)
       VALUES (?, 'vendor_bill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        nextSort,
        vb.id,
        docType,
        vb.reference_id ?? null,
        vb.po_ext_number ?? null,
        vb.po_ref_number ?? null,
        payee,
        vb.amount_cents,
        vb.document_date ?? null,
        vb.due_date ?? null,
      ]
    );
    nextSort += 1;
  }
}

// ── GET /admin/china-finance/bills ───────────────────────────────────────────
export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  await syncVeetchBills(knex);

  // Bills applied to wire transfers, grouped by wire.
  // `paid` (used to compute bill_balance_cents) counts only confirmed wires,
  // so a bill applied to a draft still shows as unpaid until the draft is
  // confirmed.
  const { rows: confirmedBills } = await knex.raw(`
    WITH paid AS (
      SELECT cwta.bill_id, SUM(cwta.applied_cents)::integer AS paid_cents
      FROM china_wire_transfer_application cwta
      JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
      WHERE cwt.status = 'confirmed'
      GROUP BY cwta.bill_id
    )
    SELECT
      cfb.id, cfb.type, cfb.sort_order, cfb.document_type,
      cfb.invoice_number, cfb.po_number, cfb.po_ref_number,
      cfb.payee, cfb.description,
      cfb.amount_cents AS amount_cents,
      cwta.applied_cents AS applied_cents,
      cfb.amount_cents AS original_amount_cents,
      cfb.split_group_id, cfb.partial_seq, cfb.split_version,
      COALESCE((SELECT SUM(g.amount_cents)::integer FROM china_finance_bill g WHERE g.split_group_id = cfb.split_group_id), cfb.amount_cents) AS group_total_cents,
      COALESCE((SELECT SUM(a.applied_cents)::integer FROM china_wire_transfer_application a JOIN china_finance_bill gb ON gb.id = a.bill_id WHERE gb.split_group_id = cfb.split_group_id), 0) AS group_paid_cents,
      GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) AS bill_balance_cents,
      cfb.document_date, cfb.due_date,
      cfb.vendor_bill_id,
      vb.number AS vendor_bill_number,
      cwta.wire_transfer_id,
      vb.purchase_order_id AS po_id,
      cwt.status        AS wire_status,
      cwt.sent_date     AS wire_sent_date,
      cwt.wire_amount_cents,
      cwt.bank_fee_cents,
      cwt.received_amount_cents,
      cwt.confirmed_date
     FROM china_wire_transfer_application cwta
     JOIN china_finance_bill cfb ON cfb.id = cwta.bill_id
     JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
     LEFT JOIN vendor_bill vb ON vb.id = cfb.vendor_bill_id
     LEFT JOIN paid ON paid.bill_id = cfb.id
    ORDER BY
      cwt.sent_date ASC NULLS LAST,
      cfb.document_date ASC NULLS LAST,
      cfb.due_date ASC NULLS LAST,
      cfb.po_ref_number ASC NULLS LAST,
      CASE cfb.document_type
        WHEN 'commercial_invoice' THEN 1
        WHEN 'purchasing_services' THEN 2
        WHEN 'shipping_cost' THEN 3
        WHEN 'bank_fee' THEN 4
        ELSE 5
      END,
      cwta.sort_order ASC,
      cfb.sort_order ASC,
      cfb.partial_seq ASC NULLS FIRST
  `) as { rows: Array<Record<string, unknown>> };

  // Group confirmed bills by wire_transfer_id
  const wireMap = new Map<string, { wire: Record<string, unknown>; bills: Array<Record<string, unknown>> }>();
  for (const row of confirmedBills) {
    const wid = row.wire_transfer_id as string;
    if (!wireMap.has(wid)) {
      wireMap.set(wid, {
        wire: {
          id: wid,
          status: row.wire_status,
          sent_date: row.wire_sent_date,
          wire_amount_cents: row.wire_amount_cents,
          bank_fee_cents: row.bank_fee_cents,
          received_amount_cents: row.received_amount_cents,
          confirmed_date: row.confirmed_date,
        },
        bills: [],
      });
    }
    wireMap.get(wid)!.bills.push(row);
  }
  const confirmed = Array.from(wireMap.values());

  // Pending bills have a positive remaining balance, ordered by document date.
  // Draft wires are reservations only — they do NOT reduce the bill's pending
  // balance until they are confirmed.
  const today = new Date().toISOString().slice(0, 10);
  const { rows: pending } = await knex.raw(
    `WITH paid AS (
       SELECT cwta.bill_id, SUM(cwta.applied_cents)::integer AS paid_cents
       FROM china_wire_transfer_application cwta
       JOIN china_wire_transfer cwt ON cwt.id = cwta.wire_transfer_id
       WHERE cwt.status = 'confirmed'
       GROUP BY cwta.bill_id
     )
     SELECT
       cfb.id, cfb.type, cfb.sort_order, cfb.document_type,
       cfb.invoice_number, cfb.po_number, cfb.po_ref_number,
       cfb.payee, cfb.description, cfb.amount_cents,
       cfb.amount_cents AS original_amount_cents,
       cfb.split_group_id, cfb.partial_seq, cfb.split_version,
       COALESCE((SELECT SUM(g.amount_cents)::integer FROM china_finance_bill g WHERE g.split_group_id = cfb.split_group_id), cfb.amount_cents) AS group_total_cents,
       COALESCE((SELECT SUM(a.applied_cents)::integer FROM china_wire_transfer_application a JOIN china_finance_bill gb ON gb.id = a.bill_id WHERE gb.split_group_id = cfb.split_group_id), 0) AS group_paid_cents,
       GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) AS bill_balance_cents,
       cfb.document_date, cfb.due_date,
       cfb.vendor_bill_id,
       vb.number AS vendor_bill_number,
       vb.purchase_order_id AS po_id,
       (cfb.due_date IS NOT NULL AND cfb.due_date < ?) AS is_past_due
     FROM china_finance_bill cfb
     LEFT JOIN vendor_bill vb ON vb.id = cfb.vendor_bill_id
     LEFT JOIN paid ON paid.bill_id = cfb.id
     WHERE GREATEST(cfb.amount_cents - COALESCE(paid.paid_cents, 0), 0) > 0
     ORDER BY
       cfb.document_date ASC NULLS LAST,
       cfb.due_date ASC NULLS LAST,
       cfb.po_ref_number ASC NULLS LAST,
       CASE cfb.document_type
         WHEN 'commercial_invoice' THEN 1
         WHEN 'purchasing_services' THEN 2
         WHEN 'shipping_cost' THEN 3
         WHEN 'bank_fee' THEN 4
         ELSE 5
       END,
       cfb.sort_order ASC,
       cfb.partial_seq ASC NULLS FIRST`,
    [today]
  ) as { rows: Array<Record<string, unknown>> };

  // Balance summary
  const { rows: summary } = await knex.raw(`
    SELECT
      COALESCE(SUM(cfb.amount_cents), 0) AS total_expenses_cents,
      COALESCE((
        SELECT SUM(cwta.applied_cents)
        FROM china_wire_transfer_application cwta
      ), 0) AS total_covered_cents,
      COALESCE((
        SELECT SUM(cwt.received_amount_cents)
        FROM china_wire_transfer cwt
        WHERE cwt.status = 'confirmed'
      ), 0) AS total_received_cents
    FROM china_finance_bill cfb
  `) as { rows: [{ total_expenses_cents: number; total_covered_cents: number; total_received_cents: number }] };

  const s = summary[0];
  const balance_cents = s.total_received_cents - s.total_expenses_cents;

  // ── Overpay credits ────────────────────────────────────────────────────────
  // usable_credits = the POOL (per source bill: generated − consumed > 0),
  // wire_credits   = the consumption lines, grouped per wire for display.
  // Derived live, never materialised. Missing table (pre-migration) → empty.
  let usable_credits: Array<Record<string, unknown>> = [];
  let creditsByWire = new Map<string, Array<Record<string, unknown>>>();
  try {
    const { rows: pool } = await knex.raw(`
      WITH confirmed_paid AS (
        SELECT a.bill_id, SUM(a.applied_cents)::bigint AS applied
          FROM china_wire_transfer_application a
          JOIN china_wire_transfer w ON w.id = a.wire_transfer_id
         WHERE w.status = 'confirmed'
         GROUP BY a.bill_id
      ), consumed AS (
        SELECT c.source_bill_id, SUM(c.amount_cents)::bigint AS used
          FROM china_finance_wire_credit c
         GROUP BY c.source_bill_id
      )
      SELECT b.id AS source_bill_id,
             b.invoice_number,
             b.document_type,
             vb.number AS vendor_bill_number,
             cp.applied::int AS confirmed_applied_cents,
             b.amount_cents,
             GREATEST(cp.applied - b.amount_cents, 0)::int AS generated_cents,
             COALESCE(co.used, 0)::int AS consumed_cents,
             (GREATEST(cp.applied - b.amount_cents, 0) - COALESCE(co.used, 0))::int AS available_cents,
             (SELECT w.sent_date::text
                FROM china_wire_transfer_application a2
                JOIN china_wire_transfer w ON w.id = a2.wire_transfer_id
               WHERE a2.bill_id = b.id AND w.status = 'confirmed'
               ORDER BY w.sent_date DESC NULLS LAST LIMIT 1) AS origin_sent_date
        FROM china_finance_bill b
        JOIN confirmed_paid cp ON cp.bill_id = b.id
        LEFT JOIN consumed co ON co.source_bill_id = b.id
        LEFT JOIN vendor_bill vb ON vb.id = b.vendor_bill_id
       WHERE cp.applied > b.amount_cents
       ORDER BY origin_sent_date DESC NULLS LAST
    `) as { rows: Array<Record<string, unknown>> };
    usable_credits = pool.filter((p) => Number(p.available_cents) > 0);

    const { rows: lines } = await knex.raw(`
      SELECT c.id, c.wire_transfer_id, c.source_bill_id, c.amount_cents, c.note,
             c.source_wire_sent_date_at_apply::text AS origin_sent_date,
             c.source_applied_cents_at_apply,
             c.source_bill_amount_cents_at_apply,
             -- LIVE generated credit of the source bill — lets the UI flag a
             -- line as PARTIAL when it consumed only part of the credit (incl.
             -- when a later correction generated more after this line applied).
             GREATEST(COALESCE((SELECT SUM(a.applied_cents)::bigint
                                  FROM china_wire_transfer_application a
                                  JOIN china_wire_transfer w ON w.id = a.wire_transfer_id
                                 WHERE a.bill_id = b.id AND w.status = 'confirmed'), 0)
                      - b.amount_cents, 0)::int AS source_generated_cents,
             b.invoice_number, vb.number AS vendor_bill_number
        FROM china_finance_wire_credit c
        JOIN china_finance_bill b ON b.id = c.source_bill_id
        LEFT JOIN vendor_bill vb ON vb.id = b.vendor_bill_id
       ORDER BY c.created_at ASC
    `) as { rows: Array<Record<string, unknown>> };
    creditsByWire = new Map();
    for (const l of lines) {
      const wid = l.wire_transfer_id as string;
      const arr = creditsByWire.get(wid);
      if (arr) arr.push(l);
      else creditsByWire.set(wid, [l]);
    }
  } catch {
    // Table not migrated yet — the page simply shows no credit pool.
  }
  for (const g of confirmed) {
    const wid = (g.wire as { id: string }).id;
    (g as Record<string, unknown>).credits = creditsByWire.get(wid) ?? [];
  }

  // Drift enrichment — same engine the vendor-bill page uses, scoped to the
  // vendor bills already on this page (never a whole-table scan). A bill whose
  // lines/commission no longer match its source gets an advisory `drift` object;
  // the UI renders it as a warning icon + message. Advisory only, and a failure
  // here must never take down the ledger.
  try {
    const pageVbIds = Array.from(
      new Set(
        [...confirmed.flatMap((g) => g.bills), ...pending]
          .map((r) => r.vendor_bill_id as string | null)
          .filter((x): x is string => !!x)
      )
    );
    if (pageVbIds.length > 0) {
      const driftMap = await loadBillDrift(knex, { vendorBillIds: pageVbIds });
      const attach = (row: Record<string, unknown>) => {
        const vbId = row.vendor_bill_id as string | null;
        const d = vbId ? driftMap.get(vbId) : undefined;
        if (d) {
          row.drift = {
            kind: d.kind,
            delta_cents: d.delta_cents,
            expected_cents: d.expected_cents,
            bill_total_cents: d.bill_total_cents,
            source_label: d.source_label,
            on_confirmed_wire: d.on_confirmed_wire,
            message: describeDrift(d),
          };
        }
      };
      for (const g of confirmed) g.bills.forEach(attach);
      for (const p of pending) attach(p);

      // Overpay-credit provenance: a PIN-audited adjustment of a paid bill left
      // `applied_cents > amount_cents`. Attach the latest adjustment note so the
      // UI can EXPLAIN the credit (the note is the sentence the buyer forwards
      // to the purchasing agent), not just show a bare green number.
      const { rows: adjRows } = await knex.raw(
        `SELECT DISTINCT ON (vendor_bill_id) vendor_bill_id, note, delta_cents
           FROM china_finance_bill_adjustment
          WHERE vendor_bill_id = ANY(?)
          ORDER BY vendor_bill_id, created_at DESC`,
        [pageVbIds]
      ).catch(() => ({ rows: [] })) as { rows: Array<{ vendor_bill_id: string; note: string | null; delta_cents: number }> };
      if (adjRows.length > 0) {
        const noteByVb = new Map(adjRows.map((a) => [a.vendor_bill_id, a.note]));
        const attachNote = (row: Record<string, unknown>) => {
          const vbId = row.vendor_bill_id as string | null;
          if (vbId && noteByVb.has(vbId)) row.adjustment_note = noteByVb.get(vbId) ?? null;
        };
        for (const g of confirmed) g.bills.forEach(attachNote);
        for (const p of pending) attachNote(p);
      }
    }
  } catch (e) {
    console.warn(
      `[china-finance] drift enrichment failed: ${e instanceof Error ? e.message : e}`
    );
  }

  return res.json({ confirmed, pending, balance_cents, summary: s, usable_credits });
};

// ── POST /admin/china-finance/bills ──────────────────────────────────────────
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const parsed = createBillSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation error", errors: parsed.error.flatten() });
  }

  const knex = (req.scope as unknown as { resolve: (k: string) => unknown })
    .resolve("__pg_connection__") as Knex;

  const { rows: maxRow } = await knex.raw(
    `SELECT COALESCE(MAX(sort_order), 0) AS max_so FROM china_finance_bill`
  ) as { rows: [{ max_so: number }] };

  const id = randomUUID();
  const { document_type, invoice_number, po_number, po_ref_number,
          payee, description, amount_cents, document_date, due_date } = parsed.data;

  await knex.raw(
    `INSERT INTO china_finance_bill
       (id, type, sort_order, document_type, invoice_number, po_number,
        po_ref_number, payee, description, amount_cents, document_date, due_date)
     VALUES (?, 'legacy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      maxRow[0].max_so + 1,
      document_type,
      invoice_number ?? null,
      po_number ?? null,
      po_ref_number ?? null,
      payee ?? null,
      description ?? null,
      amount_cents,
      document_date ?? null,
      due_date ?? null,
    ]
  );

  const { rows } = await knex.raw(
    `SELECT * FROM china_finance_bill WHERE id = ?`, [id]
  ) as { rows: [Record<string, unknown>] };

  return res.status(201).json({ bill: rows[0] });
};
