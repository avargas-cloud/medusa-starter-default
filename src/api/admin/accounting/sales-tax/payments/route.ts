import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { createSalesTaxAdjustment } from "../../../../../lib/ledger/documents/sales-tax-adjustment";
import { createSalesTaxPayment, listSalesTaxPayments } from "../../../../../lib/ledger/documents/sales-tax-payment";
import { runInPostingTransaction } from "../../../../../lib/ledger/post";
import { LedgerError } from "../../../../../lib/ledger/types";
import { isPeriod } from "../../../../../lib/sales-tax/due-dates";
import { fileSalesTaxReturn, getSalesTaxReturn, prepareSalesTaxReturn } from "../../../../../lib/sales-tax/returns";
import { loadSalesTaxSettings } from "../../../../../lib/sales-tax/settings";

import { CENTS_SCHEMA, DAY_SCHEMA, PERIOD_SCHEMA, invalid, withAccounting, withAccountingAndPin } from "../_lib/common";

/**
 * GET  /admin/accounting/sales-tax/payments?period=YYYY-MM&limit → { items }
 * POST /admin/accounting/sales-tax/payments  (PIN)
 *      { period, day, bank_account_list_id?, tax_cents, adjustment_ids?: [], reference?, memo?,
 *        collection_allowance_cents?, file_return? (default true) }
 *      → 201 { payment, post, allowance?: adjustment, return? }
 *      "Ya presenté y pagué", en UNA transacción: (1) si viene `collection_allowance_cents` crea y
 *      postea el STA de allowance del período y lo aplica; (2) crea Y postea el pago (Dr payable /
 *      Cr banco por el neto) y encola el SalesTaxPaymentCheckAdd; (3) con `file_return` deja la
 *      declaración congelada y `filed` con `reference` como confirmación del DOR (si ya estaba
 *      preparada, sólo la marca filed; si ya estaba filed, no la toca). El monto NO se manda: es
 *      tax_cents ± los STA aplicados (derivado en el servidor).
 *      409 GL_SOURCE_INVALID reason=settings_not_ready si falta tax item / vendor.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const period = typeof req.query.period === "string" && isPeriod(req.query.period) ? req.query.period : null;
  const limit = Number.parseInt(String(req.query.limit ?? "200"), 10);
  await withAccounting(req, res, async (client) => {
    res.json({ items: await listSalesTaxPayments(client, { period, limit: Number.isFinite(limit) ? limit : 200 }) });
  });
}

const BODY = z.object({
  period: PERIOD_SCHEMA,
  day: DAY_SCHEMA,
  bank_account_list_id: z.string().trim().min(1).optional(),
  tax_cents: CENTS_SCHEMA,
  adjustment_ids: z.array(z.string().trim().min(1)).max(20).optional(),
  reference: z.string().trim().max(80).nullable().optional(),
  memo: z.string().trim().max(2000).nullable().optional(),
  collection_allowance_cents: CENTS_SCHEMA.refine((v) => v > 0n, "collection_allowance_cents must be > 0").optional(),
  file_return: z.boolean().optional(),
});

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = BODY.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message);
  await withAccountingAndPin(req, res, async (client, actorId) => {
    const settings = await loadSalesTaxSettings(client);
    if (!settings.ready) throw new LedgerError("GL_SOURCE_INVALID", { reason: "settings_not_ready", missing: settings.missing });
    const bank = parsed.data.bank_account_list_id ?? settings.default_bank_account_list_id;
    if (!bank) throw new LedgerError("GL_SOURCE_INVALID", { reason: "bank_account_required" });
    const d = parsed.data;
    const result = await runInPostingTransaction(client, async () => {
      const adjustmentIds = [...(d.adjustment_ids ?? [])];
      let allowance = null;
      if (d.collection_allowance_cents) {
        const offset = settings.accounts.adjustment_income_list_id;
        if (!offset) throw new LedgerError("GL_SOURCE_INVALID", { reason: "offset_account_required", type: "collection_allowance" });
        allowance = await createSalesTaxAdjustment(
          client,
          {
            period: d.period,
            day: d.day,
            type: "collection_allowance",
            amount_cents: d.collection_allowance_cents,
            payable_list_id: settings.accounts.payable_list_id,
            offset_account_list_id: offset,
            vendor_list_id: settings.vendor_list_id,
            vendor_name: settings.vendor_name,
            reason: "Collection allowance (DR-15 line 14)",
          },
          actorId
        );
        adjustmentIds.push(allowance.adjustment.id);
      }
      const paid = await createSalesTaxPayment(
        client,
        {
          period: d.period,
          day: d.day,
          bank_account_list_id: bank,
          payable_list_id: settings.accounts.payable_list_id,
          vendor_list_id: settings.vendor_list_id,
          vendor_name: settings.vendor_name ?? "Sales tax agency",
          tax_item_list_id: settings.tax_item_list_id,
          tax_item_name: settings.tax_item_name,
          tax_cents: d.tax_cents,
          adjustment_ids: adjustmentIds,
          reference: d.reference ?? null,
          memo: d.memo ?? null,
        },
        actorId
      );
      let ret = null;
      if (d.file_return !== false) {
        const existing = await getSalesTaxReturn(client, d.period);
        if (!existing) await prepareSalesTaxReturn(client, settings, d.period, actorId, null);
        const current = existing ?? (await getSalesTaxReturn(client, d.period));
        if (current?.status !== "filed") {
          ret = await fileSalesTaxReturn(
            client,
            d.period,
            { confirmation_number: d.reference?.trim() || paid.payment.doc_number, filed_amount_cents: BigInt(paid.payment.total_cents) },
            actorId
          );
        } else ret = current;
      }
      return { ...paid, allowance: allowance?.adjustment ?? null, return: ret };
    });
    res.status(201).json(result);
  });
}
