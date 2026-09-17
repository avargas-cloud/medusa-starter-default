import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { createSalesTaxAdjustment, listSalesTaxAdjustments } from "../../../../../lib/ledger/documents/sales-tax-adjustment";
import { LedgerError } from "../../../../../lib/ledger/types";
import { isPeriod } from "../../../../../lib/sales-tax/due-dates";
import { loadSalesTaxSettings } from "../../../../../lib/sales-tax/settings";

import { CENTS_SCHEMA, DAY_SCHEMA, PERIOD_SCHEMA, invalid, withAccounting, withAccountingAndPin } from "../_lib/common";

/**
 * GET  /admin/accounting/sales-tax/adjustments?period=YYYY-MM → { items }
 * POST /admin/accounting/sales-tax/adjustments (PIN)
 *      { period, day, type, direction? (sólo rounding/other), amount_cents (>0), offset_account_list_id?, reason?, memo? }
 *      → 201 { adjustment, post } — crea Y postea; encola el JournalEntry con el vendor del DOR en el payable.
 *      `offset_account_list_id` default: allowance/prior_credit → sales_tax_adjustment_income; penalty/interest →
 *      sales_tax_penalty_expense (gl_account_map). Sin default ni cuenta explícita → 409 offset_account_required.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const period = typeof req.query.period === "string" && isPeriod(req.query.period) ? req.query.period : null;
  await withAccounting(req, res, async (client) => {
    res.json({ items: await listSalesTaxAdjustments(client, { period }) });
  });
}

const BODY = z.object({
  period: PERIOD_SCHEMA,
  day: DAY_SCHEMA,
  type: z.enum(["collection_allowance", "penalty", "interest", "rounding", "prior_credit", "other"]),
  direction: z.enum(["decrease", "increase"]).optional(),
  amount_cents: CENTS_SCHEMA.refine((v) => v > 0n, "amount_cents must be > 0"),
  offset_account_list_id: z.string().trim().min(1).optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  memo: z.string().trim().max(2000).nullable().optional(),
});

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const parsed = BODY.safeParse(req.body);
  if (!parsed.success) return invalid(res, parsed.error.issues[0]?.message);
  await withAccountingAndPin(req, res, async (client, actorId) => {
    const settings = await loadSalesTaxSettings(client);
    const d = parsed.data;
    const defaultOffset =
      d.type === "penalty" || d.type === "interest"
        ? settings.accounts.penalty_expense_list_id
        : settings.accounts.adjustment_income_list_id;
    const offset = d.offset_account_list_id ?? defaultOffset;
    if (!offset) throw new LedgerError("GL_SOURCE_INVALID", { reason: "offset_account_required", type: d.type });
    const result = await createSalesTaxAdjustment(
      client,
      {
        period: d.period,
        day: d.day,
        type: d.type,
        direction: d.direction,
        amount_cents: d.amount_cents,
        payable_list_id: settings.accounts.payable_list_id,
        offset_account_list_id: offset,
        vendor_list_id: settings.vendor_list_id,
        vendor_name: settings.vendor_name,
        reason: d.reason ?? null,
        memo: d.memo ?? null,
      },
      actorId
    );
    res.status(201).json(result);
  });
}
