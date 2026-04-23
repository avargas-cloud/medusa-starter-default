import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";

import { ensureCustomerInQb } from "../../../lib/quickbooks/order-flow-core";

export default async function syncSingleCustomerToQb({
  container,
  args,
}: ExecArgs) {
  const logger = container.resolve("logger");

  const customerId =
    (args && args[0]) || "cus_01KPXPXKH7X8RSP6JA27R2WMSS";

  const customerModule = container.resolve(Modules.CUSTOMER);

  const customer = await customerModule.retrieveCustomer(customerId, {
    relations: ["addresses"],
  });

  const customerForQb = {
    id: customer.id,
    email: customer.email,
    first_name: customer.first_name ?? null,
    last_name: customer.last_name ?? null,
    company_name: (customer as any).company_name ?? null,
    phone: customer.phone ?? null,
    metadata: customer.metadata ?? {},
    addresses: (customer.addresses ?? []).map((a: any) => ({
      address_1: a.address_1,
      address_2: a.address_2,
      city: a.city,
      province: a.province,
      postal_code: a.postal_code,
      is_default_billing:
        a.is_default_billing ?? a.metadata?.is_default_billing ?? false,
      is_default_shipping:
        a.is_default_shipping ?? a.metadata?.is_default_shipping ?? false,
      metadata: a.metadata ?? {},
    })),
  };

  logger.info(`[sync-single-customer-to-qb] ${customer.email} (${customer.id})`);
  logger.info(
    `[sync-single-customer-to-qb] current qb_list_id = ${(customer.metadata as any)?.qb_list_id ?? "∅"}`
  );

  const result = await ensureCustomerInQb(
    customerForQb as any,
    customerModule,
    (msg) => logger.info(msg)
  );

  logger.info(
    `[sync-single-customer-to-qb] result: ${JSON.stringify(result, null, 2)}`
  );
}
