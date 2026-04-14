import {
  createWorkflow,
  createStep,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";

interface UpdateSingleCustomerInput {
  customerId: string;
}

/**
 * INCREMENTAL SYNC: Update Single Customer
 *
 * Updates only the specified customer in MeiliSearch.
 * Used by auto-sync middleware for real-time updates.
 *
 * LOGIC (matches subscriber):
 * - customer_type: Preserved from metadata (business category)
 * - price_level: Calculated from customer groups (Wholesale/Retail)
 */

const updateSingleCustomerStep = createStep(
  "update-single-customer-step",
  async ({ customerId }: UpdateSingleCustomerInput, { container }) => {
    const logger = container.resolve("logger");
    const query = container.resolve("query");

    try {
      // Dynamic import for ESM compatibility
      const { MeiliSearch } = await import("meilisearch");

      // 1. Fetch the single customer with groups
      const { data: customers } = await query.graph({
        entity: "customer",
        fields: [
          "id",
          "email",
          "first_name",
          "last_name",
          "company_name",
          "phone",
          "has_account",
          "created_at",
          "updated_at",
          "metadata",
          "groups.name",
        ],
        filters: { id: customerId },
      });

      const customer = customers?.[0];

      if (!customer) {
        logger.warn(
          `[MEILI-INCREMENTAL] Customer ${customerId} not found, skipping sync`
        );
        return new StepResponse({ success: false, customerId: "", email: "" });
      }

      // 2. Calculate price_level from customer groups (SAME AS SUBSCRIBER)
      const customerGroups = customer.groups?.map((g: any) => g.name) || [];
      const hasWholesaleGroup = customerGroups.includes("Wholesale");
      const priceLevel = hasWholesaleGroup ? "Wholesale" : "Retail";

      // 3. Get customer_type from metadata (PRESERVE IT, DON'T CHANGE)
      const existingCustomerType =
        customer.metadata?.customer_type || "Standard";

      // 4. Initialize MeiliSearch client
      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
        apiKey: process.env.MEILISEARCH_API_KEY || "masterKey",
      });

      // 5. Transform customer for MeiliSearch
      const meiliCustomer = {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name,
        last_name: customer.last_name,
        company_name: customer.company_name || "",
        phone: customer.phone,
        has_account: customer.has_account,
        customer_type: existingCustomerType,
        price_level: priceLevel,
        status: customer.has_account ? "Registered" : "Guest",
        list_id: customer.metadata?.qb_list_id || "",
        groups: customerGroups,
        updated_at: new Date(customer.updated_at).getTime(),
        created_at: new Date(customer.created_at).getTime(),
      };

      // 6. Update in MeiliSearch
      const index = client.index("customers");
      const result = await index.addDocuments([meiliCustomer], {
        primaryKey: "id",
      });

      // 7. Wait for indexing to complete
      await (client as any).tasks.waitForTask(result.taskUid);

      logger.info(
        `[MEILI-INCREMENTAL] ✅ Customer ${customer.email} - Type: ${existingCustomerType}, Price: ${priceLevel}`
      );

      return new StepResponse({
        success: true,
        customerId: customer.id,
        email: customer.email || "",
      });
    } catch (error: any) {
      logger.error(
        `[MEILI-INCREMENTAL] ❌ Failed to update customer ${customerId}:`,
        error.message
      );
      return new StepResponse({ success: false, customerId: "", email: "" });
    }
  }
);

export const updateSingleCustomerWorkflow = createWorkflow(
  "update-single-customer",
  (input: UpdateSingleCustomerInput) => {
    const result = updateSingleCustomerStep(input);
    return new WorkflowResponse(result);
  }
);
