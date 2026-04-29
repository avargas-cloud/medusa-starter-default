import { model } from "@medusajs/utils";

/**
 * A Landing Cost is a standalone calculator/simulator for the final landed
 * unit cost of imported goods, taking commission (sourcing agent fee),
 * freight (CBM-distributed) and tariff/duties (cost-distributed) into account.
 *
 * Unlike VendorBill, a Landing Cost is NOT tied to a Purchase Order or
 * Receipt and never affects inventory, stock, or QuickBooks. It exists only
 * to help the user pre-calculate landed cost scenarios before purchasing.
 *
 * Items are added manually from inside the module (search variants or
 * free-form entry). The header header lives forever in 'draft' — users can
 * keep editing and recalculating. Persisted breakdowns are refreshed via
 * POST /admin/landing-costs/:id/recalculate.
 */
export const LandingCost = model.define("landing_cost", {
  id: model.id({ prefix: "lc" }).primaryKey(),

  // Free-form label for the calculation (e.g. "Container EAP March 2026")
  reference_id: model.text().nullable(),

  // Free-text notes
  notes: model.text().nullable(),

  // Commission (sourcing agent fee)
  commission_mode: model.text().default("percent"), // percent | fixed
  commission_rate_bps: model.number().default(0), // 1500 = 15.00%
  commission_amount_cents: model.number().default(0),
  commission_invoice_number: model.text().nullable(),

  // Freight
  freight_included: model.boolean().default(false),
  freight_amount_cents: model.number().default(0),
  freight_invoice_number: model.text().nullable(),

  // Tariff / duty
  tariff_included: model.boolean().default(false),
  tariff_amount_cents: model.number().default(0),
  tariff_number: model.text().nullable(),

  // Last recalculation audit
  recalculated_at: model.dateTime().nullable(),
});
