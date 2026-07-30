/**
 * POST /admin/vendor-bills/:id/sync-from-source
 *
 * "Update From…" — re-mirror a regular DRAFT bill's product lines from a source:
 *   { source: 'po' }                                → the PO's ordered qty (planning window)
 *   { source: 'receipt', receipt_id }               → a specific receipt's received qty
 *   { source: 'receipt', receipt_ids: string[] }     → D6 — the UNION of several
 *     receipts' received qty (SUM(qty_received_now) per purchase_order_line_id
 *     across the set). `receipt_ids` takes precedence when both are present;
 *     `receipt_id` stays supported for the single-receipt legacy caller.
 *
 * The bill's OWN purchase_order_id is used (an arbitrary PO is never accepted).
 * Merge is deterministic by purchase_order_line_id (Phase 0): updates changed
 * lines, adds new source lines, and REMOVES bill product lines no longer in the
 * source. qb_account lines are preserved. Landed cost fields reset to 0 on any
 * changed/added line (confirm recomputes them). Receipt source PINS the bill to
 * the receipt(s) (dual-write, see lib/purchase-orders/vendor-bill-receipts.ts)
 * and clamps qty to the received qty (keeps confirm/AVCO sound).
 *
 * One transaction with row locks via recomputeBillFinanceLinks; returns a diff
 * { added, updated, removed }. `preview:true` stays read-only (no writes at all,
 * including no binding) so the frontend can stage the result before Save.
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
import {
  resolveBoundReceiptIds,
  resolveReceiptLineUnion,
  syncPrimaryReceiptPointer,
  validateReceiptsForBinding,
} from "../../../../../lib/purchase-orders/vendor-bill-receipts";
import {
  qtyExceedsRemainingMessage,
  resolveRemainingPoQuantities,
  seedableLines,
} from "../../../../../lib/purchase-orders/po-billed-quantities";

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
    // D6 — either the legacy single id, or the new multi-select set.
    // `receipt_ids` wins when both are present. At least one is required —
    // checked in the handler (a `.refine()` here would turn this branch into
    // a ZodEffects, which z.discriminatedUnion() can't accept as a member).
    receipt_id: z.string().min(1).optional(),
    receipt_ids: z.array(z.string().min(1)).optional(),
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
  if (
    parsed.data.source === "receipt" &&
    !parsed.data.receipt_id &&
    (!parsed.data.receipt_ids || parsed.data.receipt_ids.length === 0)
  ) {
    return res.status(400).json({
      error: "receipt_id or receipt_ids is required for source='receipt'",
      code: "receipt_id_required",
    });
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
  const canPreviewLockedBill =
    parsed.data.preview === true &&
    (bill.status === "confirmed" || bill.status === "synced");

  if (bill.status !== "draft" && !canPreviewLockedBill) {
    return res.status(409).json({
      error:
        bill.status === "confirmed" || bill.status === "synced"
          ? "Preview the source first, then save the reviewed changes from the Vendor Bill"
          : "Only draft vendor bills can be updated from a source",
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
  let sourceLines: SourceLine[] = [];
  // D6 — the full receipt SET this "Update From Receipt(s)" call resolves to
  // (kept for the persist path below, which binds every id in the set, not
  // just a single legacy pin).
  let pinReceiptIds: string[] = [];
  // Legacy single-value mirror, used only for the response's `receipt_pinned`
  // field (kept for existing frontend callers that read it).
  let pinReceiptId: string | null = null;

  if (parsed.data.source === "receipt") {
    const requestedReceiptIds =
      parsed.data.receipt_ids && parsed.data.receipt_ids.length > 0
        ? [...new Set(parsed.data.receipt_ids)]
        : [parsed.data.receipt_id!];

    // Validate the whole set in one shot (existence, same PO, applied/synced,
    // not already bound to a DIFFERENT bill — dual-read against both the new
    // FK and the legacy pointer). A receipt already bound to THIS bill passes
    // through as a no-op.
    const validation = await validateReceiptsForBinding(knex, {
      purchaseOrderId: bill.purchase_order_id!,
      billId: id,
      receiptIds: requestedReceiptIds,
    });
    if (!validation.ok) {
      return res.status(validation.status).json(validation.body);
    }
    pinReceiptIds = requestedReceiptIds;
    pinReceiptId = requestedReceiptIds[0] ?? null;

    // UNION across the set: SUM(qty_received_now) per purchase_order_line_id,
    // grouped across every receipt in `requestedReceiptIds` (was scoped to a
    // single receipt id before D6). Unit cost resolution is unchanged. Shared
    // with POST /admin/vendor-bills/from-receipts via
    // lib/purchase-orders/vendor-bill-receipts.ts so the two paths never
    // drift on how a receipt set maps to bill lines.
    sourceLines = await resolveReceiptLineUnion(knex, requestedReceiptIds);
  }

  // What this PO still has unbilled, with THIS bill taken out of the sum (it
  // is about to be rewritten, so its current lines must not count against it).
  // A PO can carry several regular bills — one per vendor invoice on a split
  // delivery — so both sources have to be measured against the remainder
  // rather than against the raw order.
  const remainingLines = await resolveRemainingPoQuantities(
    knex,
    bill.purchase_order_id!,
    id
  );

  if (parsed.data.source !== "receipt") {
    // 'po' = the planning window: seed the unbilled remainder, not the whole
    // order, or attaching the PO to a second bill duplicates every quantity.
    sourceLines = seedableLines(remainingLines).map((line) => ({
      purchase_order_line_id: line.purchase_order_line_id,
      product_variant_id: line.product_variant_id,
      sku: line.sku_snapshot,
      description: line.description_snapshot,
      qty: line.qty_remaining,
      unit_cost_cents: line.unit_cost_cents,
      metadata: line.metadata,
    }));
  } else {
    // 'receipt' = the accountant matching the bill to the goods that actually
    // arrived. The receipt's quantities are kept as-is — they are the fact —
    // but a receipt that would push the PO past what was ordered, because a
    // sibling bill is holding the difference, is refused by name instead of
    // being silently double-billed.
    const remainingByPoLine = new Map(
      remainingLines.map((line) => [line.purchase_order_line_id, line])
    );
    for (const source of sourceLines) {
      const remaining = remainingByPoLine.get(source.purchase_order_line_id);
      if (!remaining) continue;
      if (source.qty > remaining.qty_remaining) {
        return res.status(422).json({
          error: qtyExceedsRemainingMessage(remaining, source.sku),
          code: "qty_exceeds_remaining",
          purchase_order_line_id: source.purchase_order_line_id,
          qty_remaining: remaining.qty_remaining,
          billed_on: remaining.billed_on,
        });
      }
    }
  }

  if (sourceLines.length === 0) {
    return res.status(409).json({
      error:
        parsed.data.source === "receipt" || remainingLines.length === 0
          ? "The selected source has no billable lines"
          : "Every ordered unit on this purchase order is already billed on another bill.",
      code:
        parsed.data.source === "receipt" || remainingLines.length === 0
          ? "no_source_lines"
          : "po_fully_billed",
    });
  }

  // Preview mode — return the resulting product-line set WITHOUT writing, so the
  // frontend can stage it in the browser and persist only on Save.
  if (parsed.data.preview) {
    return res.status(200).json({
      preview: true,
      source: parsed.data.source,
      receipt_pinned: pinReceiptId,
      receipt_pinned_ids: pinReceiptIds,
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
                    tax_per_unit_cents = 0,
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

    // D6 — bind every receipt in the resolved set (dual-write: new FK +
    // legacy mirror recomputed from the live bound set). Additive only — a
    // receipt already bound to this bill is untouched; nothing is unbound
    // here (that reconciliation lives in the PATCH route's `receipt_ids`).
    if (pinReceiptIds.length > 0) {
      const alreadyBound = new Set(
        await resolveBoundReceiptIds(db, id, bill.purchase_order_receipt_id)
      );
      const toBind = pinReceiptIds.filter((rid) => !alreadyBound.has(rid));
      if (toBind.length > 0) {
        await db.raw(
          `UPDATE purchase_order_receipt SET vendor_bill_id = ?, updated_at = NOW()
            WHERE id = ANY(?) AND deleted_at IS NULL`,
          [id, toBind]
        );
      }
      await syncPrimaryReceiptPointer(db, id);
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
    receipt_pinned_ids: pinReceiptIds,
    diff: { added, updated, removed },
  });
}
