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

const VEETECH_VENDOR_ID = "qbvnd_01KPGGSG2J1BEEWQE5ET30AHFC";

type Knex = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

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
       po.ordered_at::date  AS document_date,
       po.expected_at::date AS due_date,
       po.reference_number  AS po_ext_number
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
          invoice_number, po_ref_number, payee, amount_cents,
          document_date, due_date)
       VALUES (?, 'vendor_bill', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        nextSort,
        vb.id,
        docType,
        vb.reference_id ?? null,
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

  // Confirmed bills grouped by wire transfer (ordered by wire sent_date DESC)
  const { rows: confirmedBills } = await knex.raw(`
    SELECT
      cfb.id, cfb.type, cfb.sort_order, cfb.document_type,
      cfb.invoice_number, cfb.po_number, cfb.po_ref_number,
      cfb.payee, cfb.description, cfb.amount_cents,
      cfb.document_date, cfb.due_date,
      cfb.vendor_bill_id,
      cfb.wire_transfer_id,
      vb.purchase_order_id AS po_id,
      cwt.status        AS wire_status,
      cwt.sent_date     AS wire_sent_date,
      cwt.wire_amount_cents,
      cwt.bank_fee_cents,
      cwt.received_amount_cents,
      cwt.confirmed_date
    FROM china_finance_bill cfb
    JOIN china_wire_transfer cwt ON cwt.id = cfb.wire_transfer_id
    LEFT JOIN vendor_bill vb ON vb.id = cfb.vendor_bill_id
    ORDER BY cwt.sent_date ASC NULLS LAST, cfb.sort_order ASC
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

  // Pending bills (no wire_transfer_id), ordered by sort_order
  const today = new Date().toISOString().slice(0, 10);
  const { rows: pending } = await knex.raw(
    `SELECT
       cfb.id, cfb.type, cfb.sort_order, cfb.document_type,
       cfb.invoice_number, cfb.po_number, cfb.po_ref_number,
       cfb.payee, cfb.description, cfb.amount_cents,
       cfb.document_date, cfb.due_date,
       cfb.vendor_bill_id,
       vb.purchase_order_id AS po_id,
       (cfb.due_date IS NOT NULL AND cfb.due_date < ?) AS is_past_due
     FROM china_finance_bill cfb
     LEFT JOIN vendor_bill vb ON vb.id = cfb.vendor_bill_id
     WHERE cfb.wire_transfer_id IS NULL
     ORDER BY cfb.sort_order ASC`,
    [today]
  ) as { rows: Array<Record<string, unknown>> };

  // Balance summary
  const { rows: summary } = await knex.raw(`
    SELECT
      COALESCE(SUM(cfb.amount_cents), 0) AS total_expenses_cents,
      COALESCE(SUM(CASE WHEN cfb.wire_transfer_id IS NOT NULL
                   THEN cfb.amount_cents ELSE 0 END), 0) AS total_covered_cents,
      COALESCE((
        SELECT SUM(cwt.received_amount_cents)
        FROM china_wire_transfer cwt
        WHERE cwt.status = 'confirmed'
      ), 0) AS total_received_cents
    FROM china_finance_bill cfb
  `) as { rows: [{ total_expenses_cents: number; total_covered_cents: number; total_received_cents: number }] };

  const s = summary[0];
  const balance_cents = s.total_received_cents - s.total_expenses_cents;

  return res.json({ confirmed, pending, balance_cents, summary: s });
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
