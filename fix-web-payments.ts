import { MedusaContainer } from "@medusajs/framework/types";

import { FINANCE_MODULE } from "./src/modules/finance";

export default async function fixWebPayments({
  container,
}: {
  container: MedusaContainer;
}) {
  console.log("Initializing Medusa container via exec...");
  const financeService = container.resolve(FINANCE_MODULE);

  // 1. Fetch all PaymentApplications where invoice_id is null AND order is locked (coming from web)
  const applications = await financeService.listPaymentApplications(
    {
      invoice_id: null,
    },
    { relations: ["payment"] }
  );

  console.log(
    `Found ${applications.length} bogus PaymentApplications. Pruning...`
  );

  let totalFixed = 0;

  for (const app of applications) {
    if (!app.payment) continue;
    if (app.payment.source === "web" && app.payment.status === "applied") {
      // Delete the phantom application
      await financeService.deletePaymentApplications([app.id]);

      // Revert payment status to available
      await financeService.updateCustomerPayments({
        id: app.payment.id,
        status: "available",
      });

      console.log(
        ` -> Reverted Web Payment ${app.payment.id} to 'available'. Deleted app ${app.id}.`
      );
      totalFixed++;
    }
  }

  console.log(
    `Web Payment Fix Complete. Reverted ${totalFixed} CustomerPayments to 'available'.`
  );
}
