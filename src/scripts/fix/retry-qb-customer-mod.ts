/**
 * Retry pushing a Mod to QB for a specific customer. Useful when the first
 * attempt failed with a transient error (EditSeq stale, bridge busy).
 *
 * Run:
 *   CUSTOMER_ID=cus_01KPXPXKH7X8RSP6JA27R2WMSS yarn medusa exec ./src/scripts/fix/retry-qb-customer-mod.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import { syncCustomerToQb } from "../../lib/quickbooks/order-flow-core";

export default async function retryQbCustomerMod({ container }: ExecArgs): Promise<void> {
  const customerId = process.env.CUSTOMER_ID;
  if (!customerId) throw new Error("CUSTOMER_ID env var required");

  const log = (m: string) => console.log(`[retry-qb] ${m}`);
  const customerModule = container.resolve(Modules.CUSTOMER);

  const c = await customerModule.retrieveCustomer(customerId, { relations: ["addresses"] });
  log(`Retrying QB Mod for ${c.email} (id=${c.id})`);
  log(`  qb_list_id: ${(c.metadata as Record<string, unknown> | null)?.qb_list_id ?? "MISSING"}`);
  log(`  name: ${c.first_name ?? ""} ${c.last_name ?? ""} / company: ${c.company_name ?? "(none)"}`);

  const customerForQb = {
    id: c.id,
    email: c.email,
    first_name: c.first_name ?? null,
    last_name: c.last_name ?? null,
    company_name: c.company_name ?? null,
    phone: c.phone ?? null,
    metadata: (c.metadata ?? {}) as Record<string, unknown>,
    addresses: ((c.addresses ?? []) as Array<Record<string, unknown>>).map((a) => ({
      id: a.id as string,
      address_1: (a.address_1 as string | null) ?? null,
      address_2: (a.address_2 as string | null) ?? null,
      city: (a.city as string | null) ?? null,
      province: (a.province as string | null) ?? null,
      postal_code: (a.postal_code as string | null) ?? null,
      is_default_billing: (a.is_default_billing as boolean | undefined) ?? false,
      is_default_shipping: (a.is_default_shipping as boolean | undefined) ?? false,
      metadata: (a.metadata as Record<string, unknown> | null) ?? {},
    })),
  };

  const result = await syncCustomerToQb(
    customerForQb as unknown as Parameters<typeof syncCustomerToQb>[0],
    customerModule,
    (msg) => log(`  ${msg}`)
  );

  if (result.success) {
    log(`✅ QB Mod succeeded (qbCustomerId=${result.qbCustomerId ?? "n/a"})`);
  } else {
    log(`❌ QB Mod failed: ${result.error}`);
  }
}
