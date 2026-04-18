/**
 * src/api/admin/qb-catalog/waiting-invoices/[id]/mark-manual/route.ts
 *
 * POST /admin/qb-catalog/waiting-invoices/:id/mark-manual
 * Body: { variant_id: string, qb_list_id: string, qb_edit_sequence?: string }
 *
 * Manually assigns a QB ListID to a variant that is blocking the invoice gate.
 * The admin uses this when the item poller is stuck (bridge down, QB error,
 * or the item was created manually in QB Desktop outside our workflow).
 *
 * Once the variant has metadata.quickbooks_id, the qb-invoice-waiting-gate cron
 * will promote the invoice to pending on its next tick (within 2 minutes).
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

type Body = {
  variant_id: string;
  qb_list_id: string;
  qb_edit_sequence?: string;
};

export const POST = async (req: MedusaRequest<Body>, res: MedusaResponse) => {
  const knex = req.scope.resolve("__pg_connection__") as any;
  const logger = req.scope.resolve("logger");
  const { id: invoiceId } = req.params as { id: string };
  const { variant_id, qb_list_id, qb_edit_sequence } = (req.body ?? {}) as Body;

  if (!variant_id || !qb_list_id?.trim()) {
    return res
      .status(400)
      .json({ error: "variant_id and qb_list_id are required" });
  }

  try {
    // 1. Verify the invoice is actually waiting and the variant is in its list
    const invRes = await knex.raw(
      `SELECT id, metadata FROM pos_invoice WHERE id = ?`,
      [invoiceId]
    );
    const inv = (invRes.rows ?? [])[0];
    if (!inv) return res.status(404).json({ error: "invoice not found" });

    const waitingIds: string[] = inv.metadata?.waiting_variant_ids ?? [];
    if (!waitingIds.includes(variant_id)) {
      return res.status(400).json({
        error: `variant ${variant_id} is not in waiting_variant_ids for invoice ${invoiceId}`,
      });
    }

    // 2. Patch variant metadata with the manual ListID
    await knex.raw(
      `UPDATE product_variant
         SET metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object(
                'quickbooks_id', ?::text,
                'qb_edit_sequence', ?::text,
                'qb_manual_listid', true
              )
       WHERE id = ?`,
      [qb_list_id.trim(), qb_edit_sequence?.trim() ?? null, variant_id]
    );

    // 3. Mark any existing qb_item_pipeline row as synced (otherwise it stays
    //    waiting forever even though the variant is done).
    try {
      await knex.raw(
        `UPDATE qb_item_pipeline
            SET status = 'synced',
                qb_list_id = ?,
                qb_edit_sequence = ?,
                resolved_at = NOW(),
                last_error = COALESCE(last_error, '') || ' [manually resolved]'
          WHERE variant_id = ?
            AND status IN ('waiting', 'error')`,
        [qb_list_id.trim(), qb_edit_sequence?.trim() ?? null, variant_id]
      );
    } catch (pipErr: any) {
      logger.warn(
        `[mark-manual] could not update qb_item_pipeline row for variant ${variant_id}: ${pipErr.message}`
      );
    }

    logger.info(
      `[mark-manual] variant ${variant_id} → qb_list_id=${qb_list_id} (invoice ${invoiceId})`
    );

    return res.json({
      success: true,
      invoice_id: invoiceId,
      variant_id,
      qb_list_id: qb_list_id.trim(),
      message:
        "Variant marked synced. The qb-invoice-waiting-gate cron will promote the invoice within 2 min.",
    });
  } catch (err: any) {
    logger.error(`[mark-manual] failed: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
};
