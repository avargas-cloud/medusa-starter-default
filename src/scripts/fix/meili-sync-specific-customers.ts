/**
 * meili-sync-specific-customers.ts
 *
 * Upserts a targeted list of customers into the MeiliSearch `customers` index.
 * Use when customers were created/updated via direct DB insert (bypassing
 * the subscriber) or when you need to force a refresh for specific IDs.
 *
 * Usage:
 *   CUSTOMER_IDS=cus_x,cus_y yarn medusa exec ./src/scripts/fix/meili-sync-specific-customers.ts
 */

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import { MeiliSearch } from "meilisearch";

const CUSTOMER_IDS = (process.env.CUSTOMER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

export default async function meiliSyncSpecificCustomers({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const customerModule = container.resolve(Modules.CUSTOMER);

  if (CUSTOMER_IDS.length === 0) {
    logger.warn("\n⚠️  Set CUSTOMER_IDS=cus_x,cus_y to sync specific customers.\n");
    return;
  }

  const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });

  logger.info(`\n🔄 Syncing ${CUSTOMER_IDS.length} customers to MeiliSearch...\n`);

  const docs: Record<string, unknown>[] = [];

  for (const customerId of CUSTOMER_IDS) {
    try {
      const customer = await customerModule.retrieveCustomer(customerId, {
        relations: ["groups"],
      });

      if (!customer) {
        logger.warn(`  ⚠️  Not found: ${customerId}`);
        continue;
      }

      const meta = (customer.metadata as any) || {};
      const existingCustomerType =
        meta.qb_customer_type || meta.customer_type || "Standard";
      const groupNames = customer.groups?.map((g: any) => g.name) || [];
      const priceLevel =
        meta.qb_price_level ||
        meta.price_level ||
        (groupNames.includes("Wholesale") ? "Wholesale" : "Retail");

      const doc = {
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

      docs.push(doc);
      logger.info(
        `  ✅ ${customer.email} — ${(customer as any).company_name || customer.first_name} — ${priceLevel}`
      );
    } catch (err: any) {
      logger.error(`  ❌ ${customerId}: ${err.message}`);
    }
  }

  if (docs.length === 0) {
    logger.warn("\n⚠️  No documents to sync.");
    return;
  }

  const task = await client.index("customers").updateDocuments(docs);
  logger.info(`\n✅ ${docs.length} customers synced — MeiliSearch taskUid: ${task.taskUid}\n`);
}
