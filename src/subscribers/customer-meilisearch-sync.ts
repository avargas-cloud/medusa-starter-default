import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { Modules } from "@medusajs/utils";

/**
 * AUTO-SYNC CUSTOMER TO MEILISEARCH
 *
 * Listens to customer.updated and customer_group.attached/detached events
 * and automatically syncs the customer to Meilisearch with correct:
 * - customer_type
 * - price_level
 * - customer_groups
 */

export default async function customerMeilisearchSubscriber({
  event,
  container,
}: SubscriberArgs<any>) {
  const logger = container.resolve("logger");

  // Handle link events (customer group attach/detach)
  let customerId: string;

  if (event.name === "link.created" || event.name === "link.deleted") {
    // Link events don't have direct customer ID, skip for now
    // These are handled by the middleware or we can fetch from link data
    // For simplicity, we rely on customer.updated which fires after link changes
    return;
  }

  customerId = event.data.id;

  try {
    // Get customer with groups
    const customerModule = container.resolve(Modules.CUSTOMER);
    const customer = await customerModule.retrieveCustomer(customerId, {
      relations: ["groups"],
    });

    if (!customer) {
      logger.warn(
        `[MEILI-CUSTOMER-SYNC] ⚠️  Customer ${customerId} not found, skipping`
      );
      return;
    }

    // Get existing customer_type from metadata (don't overwrite it!)
    // customer_type is business category set manually in admin
    const existingCustomerType =
      (customer.metadata as any)?.customer_type || "Standard";

    // Determine price level from customer groups
    // Price Level = Wholesale if in Wholesale group, otherwise Retail
    let priceLevel = "Retail";

    if (customer.groups && customer.groups.length > 0) {
      const groupNames = customer.groups.map((g) => g.name);

      if (groupNames.includes("Wholesale")) {
        priceLevel = "Wholesale";
      }
    }

    // Build Meilisearch document
    const meta = (customer.metadata as any) || {};
    const meiliDoc = {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name || "",
      last_name: customer.last_name || "",
      company_name: (customer as any).company_name || "",
      phone: customer.phone || "",
      has_account: customer.has_account,
      customer_type: existingCustomerType,
      price_level: priceLevel,
      status: customer.has_account ? "Registered" : "Guest",
      list_id: meta.qb_list_id || "",
      groups: customer.groups?.map((g) => g.name) || [],
      updated_at: new Date(customer.updated_at).getTime(),
      created_at: new Date(customer.created_at).getTime(),
    };

    // Sync to Meilisearch
    const { MeiliSearch } = await import("meilisearch");
    const client = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });

    const index = client.index("customers");
    await index.updateDocuments([meiliDoc]);

    logger.info(
      `[MEILI-CUSTOMER-SYNC] ✅ ${customer.email} - Type: ${existingCustomerType}, Price: ${priceLevel}, Groups: ${meiliDoc.groups.join(", ") || "none"}`
    );
  } catch (error: any) {
    logger.error(
      `[MEILI-CUSTOMER-SYNC] ❌ Error syncing customer ${customerId}: ${error.message}`
    );
  }
}

export const config: SubscriberConfig = {
  event: [
    "customer.created",
    "customer.updated",
    "link.created", // When customer group is attached
    "link.deleted", // When customer group is detached
  ],
};
