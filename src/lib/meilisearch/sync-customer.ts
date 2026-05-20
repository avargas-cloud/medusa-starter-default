import { Modules } from "@medusajs/utils";

/**
 * Builds a customer's MeiliSearch document and upserts it into the
 * `customers` index.
 *
 * Single source of truth shared by:
 *   • the `customer.*` lifecycle subscriber (event-driven sync)
 *   • the QB Admin mapping routes (create-and-sync / metadata PUT), where the
 *     customer is created/updated through a *direct* module-service call that
 *     does NOT emit `customer.created`/`customer.updated`, so the subscriber
 *     never fires and the doc must be pushed explicitly.
 *
 * Non-throwing by design — a Meili hiccup logs and returns instead of breaking
 * the caller's primary write.
 */
export async function syncCustomerToMeili(
  customerId: string,
  container: any,
  logger?: any
): Promise<void> {
  const log = logger ?? container.resolve("logger");
  try {
    const customerModule = container.resolve(Modules.CUSTOMER);
    const customer = await customerModule.retrieveCustomer(customerId, {
      relations: ["groups"],
    });
    if (!customer) {
      log.warn(
        `[MEILI-CUSTOMER-SYNC] ⚠️  Customer ${customerId} not found, skipping`
      );
      return;
    }

    const meta = (customer.metadata as any) || {};

    const existingCustomerType =
      meta.qb_customer_type || meta.customer_type || "Standard";

    const groupNames = customer.groups?.map((g: any) => g.name) || [];
    const hasWholesaleGroup = groupNames.includes("Wholesale");
    const priceLevel =
      meta.qb_price_level ||
      meta.price_level ||
      (hasWholesaleGroup ? "Wholesale" : "Retail");

    const meiliDoc = {
      id: customer.id,
      email: (customer.email || "").toLowerCase(),
      first_name: customer.first_name || "",
      last_name: customer.last_name || "",
      company_name: meta.company_name || (customer as any).company_name || "",
      phone: customer.phone || "",
      has_account: customer.has_account,
      customer_type: existingCustomerType,
      price_level: priceLevel,
      status: customer.has_account ? "Registered" : "Guest",
      list_id: meta.qb_list_id || "",
      acquisition_channel: meta.acquisition_channel || "",
      default_tax: meta.default_tax || null,
      tax_exempt_reason: meta.tax_exempt_reason || null,
      groups: groupNames,
      updated_at: new Date(customer.updated_at).getTime(),
      created_at: new Date(customer.created_at).getTime(),
    };

    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    await client.index("customers").updateDocuments([meiliDoc]);

    log.info(
      `[MEILI-CUSTOMER-SYNC] ✅ ${customer.email} — Type: ${existingCustomerType}, Price: ${priceLevel}, Groups: ${meiliDoc.groups.join(", ") || "none"}`
    );
  } catch (err: any) {
    log.error(
      `[MEILI-CUSTOMER-SYNC] ❌ sync failed for ${customerId}: ${err.message}`
    );
  }
}
