/**
 * POST /admin/vendor-bills/:id/sync-from-source
 *
 * "Update From…" — re-mirror a regular DRAFT bill's product lines from a source:
 *   { source: 'po' }                      → the PO's ordered qty (planning window)
 *   { source: 'receipt', receipt_id }     → a specific receipt's received qty
 *
 * The bill's OWN purchase_order_id is used (an arbitrary PO is never accepted).
 * Merge is deterministic by purchase_order_line_id (Phase 0): updates changed
 * lines, adds new source lines, and REMOVES bill product lines no longer in the
 * source. qb_account lines are preserved. Landed cost fields reset to 0 on any
 * changed/added line (confirm recomputes them). Receipt source PINS the bill to
 * that receipt and clamps qty to the received qty (keeps confirm/AVCO sound).
 *
 * One transaction with row locks via recomputeBillFinanceLinks; returns a diff
 * { added, updated, removed }.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { randomUUID } from "crypto";
import { z } from "zod";

import { getActorUserId, UnauthenticatedError } from "../../../purchase-orders/_lib/auth";
import { zodErrorToBody } from "../../../purchase-orders/_lib/format";
import { recomputeBillFinanceLinks } from "../../../../../lib/finance/recompute-bill-finance";

type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction?: () => Promise<
    Knex & { commit: () => Promise<void>; rollback: () => Promise<void> }
  >;
};

function resolveKnex(req: AuthenticatedMedusaRequest): Knex {
  return (req.scope as unknown as { resolve: (k: string) => unknown }).resolve(
    "__pg_connection__"
  ) as Knex;
}

const bodySchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("po"), preview: z.boolean().optional() }),
  z.object({
    source: z.literal("receipt"),
    receipt_id: z.string().min(1),
    preview: z.boolean().optional(),
  }),
]);

type SourceLine = {
  purchase_order_line_id: string;
  product_variant_id: string | null;
  sku: string;
  description: string;
  qty: number;
  unit_cost_cents: number;
  metadata: Record<string, unknown> | null;
};

type ExistingLine = {
  id: string;
  purchase_order_line_id: string | null;
  qty: number;
  unit_cost_cents: number;
};

function cbmFrom(metadata: Record<string, unknown> | null): number | null {
  const raw = metadata?.cbm;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function mpnFrom(metadata: Record<string, unknown> | null): string | null {
  return typeof metadata?.mpn === "string" ? metadata.mpn : null;
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  try {
    getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(zodErrorToBody(parsed.error));
  }

  const knex = resolveKnex(req);

  const billResult = await knex.raw(
    `SELECT id, status, bill_type, purchase_order_id, purchase_order_receipt_id
       FROM vendor_bill WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  const bill = (billResult.rows[0] ?? null) as
    | {
        id: string;
        status: string;
        bill_type: string;
        purchase_order_id: string | null;
        purchase_order_receipt_id: string | null;
      }
    | null;
  if (!bill) {
    return res.status(404).json({ error: "Vendor bill not found", code: "not_found" });
  }
  if (bill.bill_type !== "regular") {
    return res.status(422).json({
      error: "Only regular bills can be updated from a purchase order or receipt",
      code: "wrong_bill_type",
    });
  }
  if (bill.status !== "draft") {
    return res.status(409).json({
      error: "Only draft vendor bills can be updated from a source",
      code: "not_draft",
    });
  }
  if (!bill.purchase_order_id) {
    return res.status(422).json({
      error: "This bill is not linked to a purchase order",
      code: "no_purchase_order",
    });
  }

  // ── Resolve source lines ────────────────────────────────────────────────────
  let sourceLines: SourceLine[];
  let pinReceiptId: string | null = null;

  if (parsed.data.source === "receipt") {
    const receiptId = parsed.data.receipt_id;
    const receiptResult = await knex.raw(
      `SELECT id, purchase_order_id, status
         FROM purchase_order_receipt
        WHERE id = ? AND deleted_at IS NULL`,
      [receiptId]
    );
    const receipt = (receiptResult.rows[0] ?? null) as
      | { id: string; purchase_order_id: string; status: string }
      | null;
    if (!receipt) {
      return res.status(404).json({ error: "Receipt not found", code: "receipt_not_found" });
    }
    if (receipt.purchase_order_id !== bill.purchase_order_id) {
      return res.status(422).json({
        error: "Receipt does not belong to this bill's purchase order",
        code: "receipt_po_mismatch",
      });
    }
    if (receipt.status !== "applied" && receipt.status !== "synced") {
      return res.status(422).json({
        error: "Receipt is not applied yet",
        code: "receipt_not_applied",
      });
    }

    // Receipt-pin conflict: another bill already owns this receipt.
    const pinnedElsewhere = await knex.raw(
      `SELECT id FROM vendor_bill
        WHERE purchase_order_receipt_id = ? AND id <> ? AND deleted_at IS NULL
        LIMIT 1`,
      [receiptId, bill.id]
    );
    if (pinnedElsewhere.rows.length > 0) {
      return res.status(409).json({
        error: "Another vendor bill is already pinned to this receipt",
        code: "receipt_already_pinned",
      });
    }
    pinReceiptId = receiptId;

    const linesResult = await knex.raw(
      `SELECT
         porl.purchase_order_line_id,
         porl.product_variant_id,
         MAX(porl.sku_snapshot)         AS sku,
         MAX(porl.description_snapshot) AS description,
         COALESCE(SUM(porl.qty_received_now), 0)::int AS qty,
         COALESCE(
           MAX(porl.unit_cost_cents_override),
           MAX(pol.unit_cost_cents),
           0
         )::int AS unit_cost_cents,
         (array_agg(pv.metadata) FILTER (WHERE pv.metadata IS NOT NULL))[1] AS metadata
       FROM purchase_order_receipt_line porl
       JOIN purchase_order_line pol ON pol.id = porl.purchase_order_line_id
       LEFT JOIN product_variant pv
         ON pv.id = porl.product_variant_id AND pv.deleted_at IS NULL
       WHERE porl.purchase_order_receipt_id = ? AND porl.deleted_at IS NULL
       GROUP BY porl.purchase_order_line_id, porl.product_variant_id
       HAVING COALESCE(SUM(porl.qty_received_now), 0) > 0`,
      [receiptId]
    );
    sourceLines = linesResult.rows as SourceLine[];
  } else {
    const linesResult = await knex.raw(
      `SELECT
         pol.id AS purchase_order_line_id,
         pol.product_variant_id,
         pol.sku_snapshot AS sku,
         pol.description_snapshot AS description,
         GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0)::int AS qty,
         COALESCE(pol.unit_cost_cents, 0)::int AS unit_cost_cents,
         pv.metadata
       FROM purchase_order_line pol
       LEFT JOIN product_variant pv
         ON pv.id = pol.product_variant_id AND pv.deleted_at IS NULL
       WHERE pol.purchase_order_id = ?
         AND pol.deleted_at IS NULL
         AND COALESCE(pol.status, 'open') <> 'cancelled'
         AND GREATEST(pol.qty_ordered - COALESCE(pol.qty_cancelled, 0), 0) > 0
       ORDER BY pol.id`,
      [bill.purchase_order_id]
    );
    sourceLines = linesResult.rows as SourceLine[];
  }

  if (sourceLines.length === 0) {
    return res.status(409).json({
      error: "The selected source has no billable lines",
      code: "no_source_lines",
    });
  }

  // Preview mode — return the resulting product-line set WITHOUT writing, so the
  // frontend can stage it in the browser and persist only on Save.
  if (parsed.data.preview) {
    return res.status(200).json({
      preview: true,
      source: parsed.data.source,
      receipt_pinned: pinReceiptId,
      lines: sourceLines.map((s) => ({
        purchase_order_line_id: s.purchase_order_line_id,
        product_variant_id: s.product_variant_id,
        sku: s.sku,
        description: s.description,
        mpn: mpnFrom(s.metadata),
        cbm_per_unit: cbmFrom(s.metadata),
        qty: s.qty,
        unit_cost_cents: s.unit_cost_cents,
      })),
    });
  }

  // ── Existing product lines on the bill ──────────────────────────────────────
  const existingResult = await knex.raw(
    `SELECT id, purchase_order_line_id, qty, unit_cost_cents
       FROM vendor_bill_line
      WHERE vendor_bill_id = ?
        AND deleted_at IS NULL
        AND COALESCE(line_type, 'product') = 'product'`,
    [id]
  );
  const existingLines = existingResult.rows as ExistingLine[];
  const existingByPol = new Map<string, ExistingLine>();
  for (const l of existingLines) {
    if (l.purchase_order_line_id) existingByPol.set(l.purchase_order_line_id, l);
  }
  const sourcePolIds = new Set(sourceLines.map((s) => s.purchase_order_line_id));

  // ── Apply the merge in a transaction, then recompute finance ────────────────
  const trx = knex.transaction ? await knex.transaction() : null;
  const db = trx ?? knex;
  let added = 0;
  let updated = 0;
  let removed = 0;

  try {
    for (const src of sourceLines) {
      const existing = existingByPol.get(src.purchase_order_line_id);
      const cbm = cbmFrom(src.metadata);
      const mpn = mpnFrom(src.metadata);

      if (existing) {
        const changed =
          existing.qty !== src.qty ||
          existing.unit_cost_cents !== src.unit_cost_cents;
        if (changed) {
          await db.raw(
            `UPDATE vendor_bill_line
                SET qty = ?,
                    unit_cost_cents = ?,
                    sku = ?,
                    description = ?,
                    mpn = ?,
                    cbm_per_unit = ?::float,
                    commission_per_unit_cents = 0,
                    freight_per_unit_cents = 0,
                    tariff_per_unit_cents = 0,
                    landed_unit_cost_cents = 0,
                    updated_at = NOW()
              WHERE id = ? AND deleted_at IS NULL`,
            [
              src.qty,
              src.unit_cost_cents,
              src.sku,
              src.description,
              mpn,
              cbm,
              existing.id,
            ]
          );
          updated += 1;
        }
      } else {
        await db.raw(
          `INSERT INTO vendor_bill_line (
             id, vendor_bill_id, receipt_line_id, purchase_order_line_id,
             line_type, product_variant_id, sku, mpn, description, qty,
             unit_cost_cents, cbm_per_unit,
             commission_per_unit_cents, freight_per_unit_cents,
             tariff_per_unit_cents, landed_unit_cost_cents,
             created_at, updated_at
           )
           VALUES (?, ?, NULL, ?, 'product', ?, ?, ?, ?, ?, ?, ?::float, 0, 0, 0, 0, NOW(), NOW())`,
          [
            `vbl_${randomUUID().replace(/-/g, "")}`,
            id,
            src.purchase_order_line_id,
            src.product_variant_id,
            src.sku,
            mpn,
            src.description,
            src.qty,
            src.unit_cost_cents,
            cbm,
          ]
        );
        added += 1;
      }
    }

    // Remove bill product lines no longer present in the source. Lines with a
    // NULL purchase_order_line_id can't be matched deterministically → they are
    // also dropped (the bill mirrors the chosen source).
    for (const l of existingLines) {
      const keep = l.purchase_order_line_id && sourcePolIds.has(l.purchase_order_line_id);
      if (!keep) {
        await db.raw(
          `UPDATE vendor_bill_line SET deleted_at = NOW(), updated_at = NOW()
            WHERE id = ? AND deleted_at IS NULL`,
          [l.id]
        );
        removed += 1;
      }
    }

    // Pin to the receipt (receipt source only).
    if (pinReceiptId) {
      await db.raw(
        `UPDATE vendor_bill
            SET purchase_order_receipt_id = ?, updated_at = NOW()
          WHERE id = ? AND deleted_at IS NULL`,
        [pinReceiptId, id]
      );
    }

    // Reconcile China-Finance projection (delta/allocation-aware, row-locked).
    const recompute = await recomputeBillFinanceLinks(db, id);
    if (!recompute.ok) {
      if (trx) await trx.rollback();
      return res.status(409).json({
        error: recompute.message,
        code: recompute.code,
        conflicts: recompute.conflicts,
      });
    }

    if (trx) await trx.commit();
  } catch (err) {
    if (trx) await trx.rollback();
    throw err;
  }

  return res.status(200).json({
    vendor_bill_id: id,
    source: parsed.data.source,
    receipt_pinned: pinReceiptId,
    diff: { added, updated, removed },
  });
}
