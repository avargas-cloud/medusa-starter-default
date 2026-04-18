/**
 * src/api/admin/qb-catalog/waiting-invoices/route.ts
 *
 * GET /admin/qb-catalog/waiting-invoices
 *   Lists pos_invoice rows held by the Fase 3 gate (metadata.waiting_qb_items=true).
 *   Each row includes the waiting variant SKUs so the admin can see which items
 *   are blocking the QB SalesReceipt/Invoice push and act ("Mark as manual").
 */
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

type WaitingInvoiceRow = {
  id: string;
  invoice_number: number | null;
  order_id: string;
  total: number;
  created_at: string;
  waiting_variant_ids: string[];
  waiting_variants: Array<{
    id: string;
    sku: string | null;
    title: string | null;
    has_qb_id: boolean;
  }>;
};

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const knex = req.scope.resolve("__pg_connection__") as any;

  try {
    const invRes = await knex.raw(
      `SELECT id, invoice_number, order_id, total, created_at, metadata
         FROM pos_invoice
        WHERE metadata ->> 'waiting_qb_items' = 'true'
        ORDER BY created_at DESC
        LIMIT 200`
    );
    const invoices: any[] = invRes.rows ?? [];

    if (invoices.length === 0) {
      return res.json({ invoices: [], count: 0 });
    }

    const allVariantIds = Array.from(
      new Set(
        invoices.flatMap((inv) => inv.metadata?.waiting_variant_ids ?? []) as string[]
      )
    );

    const variantMap = new Map<string, { sku: string | null; title: string | null; has_qb_id: boolean }>();
    if (allVariantIds.length > 0) {
      const vRes = await knex.raw(
        `SELECT id, sku, title, metadata FROM product_variant WHERE id = ANY(?::text[])`,
        [allVariantIds]
      );
      for (const v of (vRes.rows ?? []) as any[]) {
        variantMap.set(v.id, {
          sku: v.sku ?? null,
          title: v.title ?? null,
          has_qb_id: !!v.metadata?.quickbooks_id,
        });
      }
    }

    const rows: WaitingInvoiceRow[] = invoices.map((inv) => {
      const waitingIds: string[] = inv.metadata?.waiting_variant_ids ?? [];
      return {
        id: inv.id,
        invoice_number: inv.invoice_number ?? null,
        order_id: inv.order_id,
        total: Number(inv.total ?? 0),
        created_at: inv.created_at,
        waiting_variant_ids: waitingIds,
        waiting_variants: waitingIds.map((vid) => ({
          id: vid,
          sku: variantMap.get(vid)?.sku ?? null,
          title: variantMap.get(vid)?.title ?? null,
          has_qb_id: variantMap.get(vid)?.has_qb_id ?? false,
        })),
      };
    });

    return res.json({ invoices: rows, count: rows.length });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
