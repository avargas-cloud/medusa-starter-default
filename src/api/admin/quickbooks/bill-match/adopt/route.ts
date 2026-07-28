import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { generateEntityId } from "@medusajs/utils";
import { Client } from "pg";

import { queryBillByTxnId } from "../_lib/bill-query";
import { reconstructLocalBill, type PoLineForMatch } from "../_lib/reconstruct";
import {
  normalizeRequiredVendorBillReference,
  VENDOR_BILL_REFERENCE_REQUIRED_BODY,
} from "../../../../../lib/purchase-orders/vendor-bill-reference-uniqueness";

interface AdoptBody {
  po_id?: string;
  txn_id?: string;
  mode?: "adopted" | "full";
  supervisor_pin?: string;
  reason?: string;
}

/**
 * POST /admin/quickbooks/bill-match/adopt
 *
 * Records an EXISTING QuickBooks bill against a PO — no new QB document is
 * created. Writes a `vendor_bill` (qb_source='adopted', status='synced') keyed
 * by the QB TxnID.
 *  - mode='adopted': header-only mirror (amount only). Any vendor.
 *  - mode='full':    reconstructs item + freight/expense lines from QB. LOCAL
 *                    vendors only (agency multi-bill is Phase 2). Records the
 *                    bill's costs on the lines; never touches product average_cost.
 *
 * Re-queries the bill by TxnID for the authoritative amount/vendor and inserts
 * transactionally. The partial unique index on vendor_bill(qb_txn_id) is the
 * durable double-adopt guard; a race surfaces here as HTTP 409.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { po_id, txn_id, mode, supervisor_pin, reason } = (req.body ?? {}) as AdoptBody;

  if (!po_id || !txn_id || (mode !== "adopted" && mode !== "full")) {
    res.status(400).json({ error: "po_id, txn_id and mode ('adopted'|'full') are required" });
    return;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [txn_id]);

    // ── Supervisor PIN (server-side; the UI gate is not enough) ──
    const { rows: storeRows } = await client.query<{ metadata: Record<string, unknown> | null }>(
      `SELECT metadata FROM store WHERE metadata->>'pos_supervisor_pin' IS NOT NULL LIMIT 1`
    );
    const storedPin = storeRows[0]?.metadata?.pos_supervisor_pin as string | undefined;
    if (!storedPin || String(supervisor_pin ?? "") !== String(storedPin)) {
      res.status(403).json({ error: "Invalid supervisor PIN" });
      return;
    }

    // ── Resolve PO + agency flag ──
    const { rows: poRows } = await client.query<{
      id: string;
      number: string | null;
      vendor_id: string | null;
      vendor_name_snapshot: string | null;
      vendor_qb_list_id_snapshot: string | null;
      is_agency: boolean;
    }>(
      `SELECT p.id, p.number, p.vendor_id, p.vendor_name_snapshot, p.vendor_qb_list_id_snapshot,
              COALESCE((qv.metadata->>'is_china_agent') = 'true', false) AS is_agency
         FROM purchase_order p
         LEFT JOIN qb_vendor qv ON qv.id = p.vendor_id AND qv.deleted_at IS NULL
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [po_id]
    );
    const po = poRows[0];
    if (!po) {
      res.status(404).json({ error: `Purchase order ${po_id} not found` });
      return;
    }
    if (mode === "full" && po.is_agency) {
      res.status(400).json({
        error: "agency_full_phase2",
        message: "Full match for agency (China-agent) vendors is Phase 2. Use ⚡ Adopt for now.",
      });
      return;
    }

    // ── Idempotency: already recorded locally? ──
    const { rows: existing } = await client.query<{ id: string }>(
      `SELECT id FROM vendor_bill WHERE qb_txn_id = $1 AND deleted_at IS NULL LIMIT 1`,
      [txn_id]
    );
    if (existing[0]) {
      res.status(409).json({ error: "already_adopted", vendor_bill_id: existing[0].id });
      return;
    }

    // ── Authoritative re-query of the bill by TxnID ──
    const bill = await queryBillByTxnId(txn_id);
    if (!bill) {
      res.status(404).json({ error: "QB bill not found for that TxnID" });
      return;
    }
    const referenceId = normalizeRequiredVendorBillReference(bill.ref_number);
    if (!referenceId) {
      res.status(422).json(VENDOR_BILL_REFERENCE_REQUIRED_BODY);
      return;
    }
    if (bill.vendor_list_id && po.vendor_qb_list_id_snapshot && bill.vendor_list_id !== po.vendor_qb_list_id_snapshot) {
      res.status(409).json({ error: "vendor_mismatch", message: "QB bill vendor differs from the PO vendor." });
      return;
    }

    // ── Full mode: validate + reconstruct lines ──
    let reconstructed: ReturnType<typeof reconstructLocalBill> | null = null;
    let descByPoLine = new Map<string, string>();
    if (mode === "full") {
      const { rows: lineRows } = await client.query<{
        po_line_id: string;
        qb_txn_line_id: string | null;
        product_variant_id: string | null;
        variant_qb_item_list_id: string | null;
        sku_snapshot: string;
        description_snapshot: string;
        qty_ordered: number;
        already_billed_qty: number;
      }>(
        `SELECT pol.id AS po_line_id, pol.qb_txn_line_id, pol.product_variant_id,
                pv.metadata->>'quickbooks_id' AS variant_qb_item_list_id,
                pol.sku_snapshot, pol.description_snapshot,
                GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled,0),0) AS qty_ordered,
                COALESCE((
                  SELECT SUM(vbl.qty) FROM vendor_bill_line vbl
                    JOIN vendor_bill vb ON vb.id = vbl.vendor_bill_id
                   WHERE vbl.purchase_order_line_id = pol.id
                     AND vbl.deleted_at IS NULL
                     AND COALESCE(vbl.line_type,'product') = 'product'
                     AND vb.bill_type = 'regular'
                     AND vb.status IN ('confirmed','synced')
                     AND vb.deleted_at IS NULL
                ), 0) AS already_billed_qty
           FROM purchase_order_line pol
           LEFT JOIN product_variant pv ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
          WHERE pol.purchase_order_id = $1 AND pol.deleted_at IS NULL`,
        [po_id]
      );
      const poLines: PoLineForMatch[] = lineRows.map((r) => {
        descByPoLine.set(r.po_line_id, r.description_snapshot);
        return {
          po_line_id: r.po_line_id,
          qb_txn_line_id: r.qb_txn_line_id,
          product_variant_id: r.product_variant_id,
          variant_qb_item_list_id: r.variant_qb_item_list_id,
          sku: r.sku_snapshot,
          cbm_per_unit: null, // landed unused for adopted bills; cbm locks only at native confirm
          qty_ordered: Number(r.qty_ordered),
          already_billed_qty: Number(r.already_billed_qty),
        };
      });
      reconstructed = reconstructLocalBill(bill, poLines);
      if (!reconstructed.ok) {
        res.status(422).json({ error: "reconstruction_failed", errors: reconstructed.errors });
        return;
      }
    }

    // ── Transactional insert ──
    const actor = ((req as unknown as { auth_context?: { actor_id?: string } }).auth_context?.actor_id) ?? "system";
    const billId = generateEntityId("", "vb");
    const documentDate = bill.txn_date ? `${bill.txn_date}T12:00:00Z` : null;
    const note =
      `Matched from QuickBooks via Bill Match (${mode}) by ${actor} on ${new Date().toISOString()}. ` +
      `QB TxnID ${bill.txn_id}, ref ${bill.ref_number || "-"}, total $${(bill.total_cents / 100).toFixed(2)}, ` +
      `AmountDue $${(bill.amount_due_cents / 100).toFixed(2)}.` +
      (reason ? ` Reason: ${reason}` : "");

    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO vendor_bill (
           id, purchase_order_id, vendor_id, vendor_name_snapshot, vendor_qb_list_id_snapshot,
           bill_type, status, qb_source, qb_txn_id, qb_edit_sequence, qb_ref_number, reference_id,
           document_date, qb_synced_at, qb_amount_due_cents, number, notes, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           'regular', 'synced', 'adopted', $6, $7, $8, $9,
           $10, NOW(), $11, NULL, $12, NOW(), NOW()
         )`,
        [
          billId,
          po.id,
          po.vendor_id,
          po.vendor_name_snapshot,
          po.vendor_qb_list_id_snapshot,
          bill.txn_id,
          bill.edit_sequence,
          referenceId,
          referenceId,
          documentDate,
          bill.amount_due_cents,
          note,
        ]
      );

      if (mode === "full" && reconstructed) {
        for (const il of reconstructed.item_lines) {
          await client.query(
            `INSERT INTO vendor_bill_line (
               id, vendor_bill_id, purchase_order_line_id, product_variant_id,
               line_type, line_kind, sku, description, qty, unit_cost_cents, cbm_per_unit,
               qb_txn_line_id, created_at, updated_at
             ) VALUES ($1,$2,$3,$4,'product','po_item',$5,$6,$7,$8,$9,$10,NOW(),NOW())`,
            [
              generateEntityId("", "vbl"),
              billId,
              il.po_line_id,
              il.product_variant_id,
              il.sku ?? "",
              descByPoLine.get(il.po_line_id) ?? il.sku ?? "(item)",
              Math.round(il.qty),
              il.unit_cost_cents,
              il.cbm_per_unit,
              il.qb_txn_line_id || null,
            ]
          );
        }
        for (const el of reconstructed.expense_lines) {
          await client.query(
            `INSERT INTO vendor_bill_line (
               id, vendor_bill_id, line_type, line_kind, sku, description, qty,
               unit_cost_cents, landed_unit_cost_cents, amount_cents,
               freight_account_list_id, qb_account_list_id, qb_account_full_name,
               qb_txn_line_id, created_at, updated_at
             ) VALUES ($1,$2,'qb_account','freight_charge',$3,$4,1,$5,$5,$6,$7,$7,$8,$9,NOW(),NOW())`,
            [
              generateEntityId("", "vbl"),
              billId,
              (el.account_full_name || "FREIGHT").slice(0, 100),
              el.memo || el.account_full_name || "Freight charge",
              el.amount_cents,
              el.amount_cents,
              el.account_list_id,
              el.account_full_name || null,
              el.qb_txn_line_id || null,
            ]
          );
        }
      }
      await client.query("COMMIT");
    } catch (txErr: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (typeof txErr === "object" && txErr && (txErr as { code?: string }).code === "23505") {
        res.status(409).json({ error: "already_adopted", message: "This QB bill was just recorded by another request." });
        return;
      }
      throw txErr;
    }

    res.json({
      success: true,
      vendor_bill_id: billId,
      mode,
      po_id: po.id,
      qb_txn_id: bill.txn_id,
      amount_due_cents: bill.amount_due_cents,
      total_cents: bill.total_cents,
      item_lines: reconstructed?.item_lines.length ?? 0,
      expense_lines: reconstructed?.expense_lines.length ?? 0,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to adopt QB bill";
    console.error(`[QB Bill Match adopt txn=${txn_id}] Error:`, error);
    res.status(500).json({ error: msg });
  } finally {
    await client.end().catch(() => undefined);
  }
}
