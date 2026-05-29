import { MedusaContainer } from "@medusajs/framework/types";

import { FINANCE_MODULE } from "./src/modules/finance";

/**
 * RETIRED 2026-05-29.
 *
 * This script used to DELETE order-only PaymentApplications for web payments,
 * treating them as "phantom" records. As of the Treasury payment-linking work,
 * web payments INTENTIONALLY create an order-only PaymentApplication at capture
 * time (see subscribers/finance-payment-captured.ts) so the sale is visible to
 * Treasury. Running the old logic would now DELETE those legitimate links and
 * corrupt Treasury attribution — so it is disabled.
 *
 * Kept as a no-op (rather than removed) to neutralize any cron/runbook that
 * still references it.
 */
export default async function fixWebPayments(_: { container: MedusaContainer }) {
  void FINANCE_MODULE;
  console.warn(
    "[fix-web-payments] RETIRED — web order-only PaymentApplications are now intentional. No action taken."
  );
}
