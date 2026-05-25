import { Modules } from "@medusajs/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import type { EntityReconciler } from "../drift-reconciler";
import { syncCustomerToMeili } from "../sync-customer";

/**
 * Builds the same payload that {@link syncCustomerToMeili} writes, so we can
 * compare it against the live Meili document.
 */
async function buildExpectedCustomerDoc(
  customerId: string,
  container: MedusaContainer
): Promise<Record<string, unknown> | null> {
  const customerModule = container.resolve(Modules.CUSTOMER);
  const customer = await customerModule.retrieveCustomer(customerId, {
    relations: ["groups"],
  });
  if (!customer) return null;

  const meta = (customer.metadata as Record<string, unknown> | null) ?? {};
  const groups = (customer.groups as { name?: string }[] | undefined) ?? [];
  const groupNames = groups.map((g) => g.name).filter((n): n is string => !!n);

  const existingCustomerType =
    (meta.qb_customer_type as string | undefined) ||
    (meta.customer_type as string | undefined) ||
    "Standard";

  const hasWholesaleGroup = groupNames.includes("Wholesale");
  const priceLevel =
    (meta.qb_price_level as string | undefined) ||
    (meta.price_level as string | undefined) ||
    (hasWholesaleGroup ? "Wholesale" : "Retail");

  return {
    id: customer.id,
    email: (customer.email ?? "").toLowerCase(),
    first_name: customer.first_name ?? "",
    last_name: customer.last_name ?? "",
    company_name:
      (meta.company_name as string | undefined) ??
      (customer as { company_name?: string }).company_name ??
      "",
    phone: customer.phone ?? "",
    customer_type: existingCustomerType,
    price_level: priceLevel,
    list_id: (meta.qb_list_id as string | undefined) ?? "",
    acquisition_channel: (meta.acquisition_channel as string | undefined) ?? "",
    default_tax: (meta.default_tax as string | undefined) ?? null,
    tax_exempt_reason:
      (meta.tax_exempt_reason as string | undefined) ?? null,
    groups: groupNames,
  };
}

export const customerReconciler: EntityReconciler = {
  entityType: "customer",
  meiliIndex: "customers",
  // Fields that affect the customer listing UI / search. Match these to
  // what users see — if any disagrees with Meili, the listing is wrong.
  comparableFields: [
    "email",
    "first_name",
    "last_name",
    "company_name",
    "phone",
    "customer_type",
    "price_level",
    "list_id",
    "acquisition_channel",
    "default_tax",
    "groups",
  ],
  buildExpectedDoc: buildExpectedCustomerDoc,
  syncOne: (id, container) => syncCustomerToMeili(id, container),
  fetchUpdatedIdsSince: async (sql, sinceIso, limit) => {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM customer
      WHERE deleted_at IS NULL
        AND updated_at >= ${sinceIso}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
  },
};
