import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { getBusinessDateString } from "../../../../../../lib/date/et";
import { listSalesTaxAdjustments } from "../../../../../../lib/ledger/documents/sales-tax-adjustment";
import { listSalesTaxPayments } from "../../../../../../lib/ledger/documents/sales-tax-payment";
import { listPeriods, loadExemptCustomers } from "../../../../../../lib/sales-tax/period-engine";
import { getSalesTaxReturn } from "../../../../../../lib/sales-tax/returns";
import { loadSalesTaxSettings } from "../../../../../../lib/sales-tax/settings";

import { periodParam, withAccounting } from "../../_lib/common";

/**
 * GET /admin/accounting/sales-tax/periods/:period
 *   → { period, live: PeriodSummary (cálculo de hoy), return: fila congelada | null,
 *       frozen: PeriodSummary | null (lo que se preparó), exempt_customers, adjustments, payments, settings }
 * `live` y `frozen` van juntos a propósito: si difieren después de preparar, la
 * pantalla lo dice ("changed since prepared") en vez de reescribir la declaración.
 */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const period = periodParam(req, res);
  if (!period) return;
  await withAccounting(req, res, async (client) => {
    const settings = await loadSalesTaxSettings(client);
    const [[live], ret, exempt, adjustments, payments] = await Promise.all([
      listPeriods(client, settings, period, period, getBusinessDateString()),
      getSalesTaxReturn(client, period),
      loadExemptCustomers(client, period),
      listSalesTaxAdjustments(client, { period }),
      listSalesTaxPayments(client, { period }),
    ]);
    const frozen = (ret?.figures as { summary?: unknown } | null)?.summary ?? null;
    res.json({
      period,
      live,
      return: ret,
      frozen,
      exempt_customers: exempt,
      adjustments,
      payments,
      settings: {
        ready: settings.ready,
        missing: settings.missing,
        tax_item_list_id: settings.tax_item_list_id,
        tax_item_name: settings.tax_item_name,
        vendor_list_id: settings.vendor_list_id,
        vendor_name: settings.vendor_name,
        default_bank_account_list_id: settings.default_bank_account_list_id,
        payable_list_id: settings.accounts.payable_list_id,
        adjustment_income_list_id: settings.accounts.adjustment_income_list_id,
        penalty_expense_list_id: settings.accounts.penalty_expense_list_id,
        variance_tolerance_cents: settings.variance_tolerance_cents,
      },
    });
  });
}
