/**
 * src/api/admin/invoices/[id]/route.ts
 * GET   /admin/invoices/:id — Get a single invoice with items + tracking + payments
 * PATCH /admin/invoices/:id — Update invoice total (auto-synced when order items/shipping/promotions change)
 *                           → balance_due is recalculated from existing payments automatically
 */

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { INVOICE_MODULE } from "../../../../modules/invoices";
import { getAppliedInvoiceTotal, getNum } from "../payment-balance";
import { sortDocItemsByInsertion } from "../_lib/item-order";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const id = req.params.id!;

  let invoice: any;
  try {
    invoice = await invoiceService.retrievePosInvoice(id, {
      relations: ["items", "tracking_links"],
    });
  } catch {
    return res.status(404).json({ error: "Invoice not found" });
  }

  // Also load payments
  const payments = await invoiceService
    .listInvoicePayments({ invoice_id: id }, { order: { paid_at: "ASC" } })
    .catch(() => []);

  // The `items` hasMany has no default ORDER BY → restore insertion (ULID id)
  // order so comment/header lines stay where the operator placed them.
  const invoiceItems = sortDocItemsByInsertion(
    (invoice as any).items
  ) as Array<{
    variant_id?: string | null;
    [key: string]: unknown;
  }>;
  const variantIds = [
    ...new Set(invoiceItems.map((item) => item.variant_id).filter(Boolean)),
  ] as string[];
  const thumbnailByVariantId = new Map<string, string | null>();

  if (variantIds.length > 0) {
    try {
      const pgConnection = req.scope.resolve("__pg_connection__") as any;
      const rows = await pgConnection.raw(
        `SELECT pv.id,
                COALESCE(pv.thumbnail, p.thumbnail) AS thumbnail
           FROM product_variant pv
           LEFT JOIN product p ON p.id = pv.product_id
          WHERE pv.id = ANY(?)`,
        [variantIds]
      );

      for (const row of rows.rows ?? []) {
        thumbnailByVariantId.set(row.id, row.thumbnail ?? null);
      }
    } catch {
      /* non-critical */
    }
  }

  // Ajuste de redondeo VIVO de esta factura, si lo tiene. No es un pago —es el
  // asiento que explica por qué el balance cerró sin que entrara el último
  // centavo— así que viaja aparte de `payments` y NO se suma a `amount_paid`:
  // mezclarlo sería exactamente el pago-fantasma que este mecanismo elimina.
  // A lo sumo hay uno vivo (índice único parcial).
  const roundingAdjustment = await (invoiceService as any)
    .listRoundingAdjustments({ invoice_id: id, voided_at: null })
    .then((rows: any[]) => rows?.[0] ?? null)
    .catch(() => null);

  const hydratedInvoice = {
    ...invoice,
    items: invoiceItems.map((item) => ({
      ...item,
      thumbnail: item.variant_id
        ? thumbnailByVariantId.get(item.variant_id) ?? null
        : null,
    })),
    /** Centavos absorbidos por redondeo. 0 = la factura cerró sin ajuste. */
    rounding_adjustment_cents: roundingAdjustment
      ? Number(roundingAdjustment.amount_cents ?? 0)
      : 0,
  };

  return res.json({
    invoice: hydratedInvoice,
    payments,
    rounding_adjustment: roundingAdjustment,
  });
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const invoiceService = req.scope.resolve(INVOICE_MODULE);
  const id = req.params.id!;
  const { total } = req.body as { total: number };

  if (!total || total <= 0) {
    return res
      .status(400)
      .json({ error: "total must be a positive number (cents)" });
  }

  try {
    const invoice = await invoiceService.retrievePosInvoice(id);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "voided") {
      return res.status(400).json({ error: "Cannot update a voided invoice" });
    }

    // Recalculate balance from the customer-payment ledger when present.
    const totalPaid = await getAppliedInvoiceTotal(req.scope, id);
    const balanceDue = getNum(total) - totalPaid;
    const newStatus =
      balanceDue <= 0 ? "paid" : totalPaid > 0 ? "partial" : invoice.status;

    await invoiceService.updatePosInvoices({
      id,
      total,
      balance_due: balanceDue,
      amount_paid: totalPaid,
      status: newStatus,
    });

    const updated = await invoiceService.retrievePosInvoice(id);
    return res.json({ invoice: updated });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
