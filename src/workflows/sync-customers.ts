import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";
import { ContainerRegistrationKeys } from "@medusajs/utils";

import { safeSyncIndex } from "../lib/meilisearch/safe-sync";

// Simple in-memory lock to prevent concurrent syncs
let isSyncing = false;

export const syncCustomersToMeiliStep = createStep(
  "sync-customers-to-meili-step",
  async (_, { container }) => {
    if (isSyncing) {
      console.log("⚠️ Sync requested but already in progress. Skipping.");
      return new StepResponse({
        success: false,
        message: "Sync already in progress",
        synced: 0,
      });
    }

    isSyncing = true;
    console.log("🔒 Acquired Sync Lock");

    try {
      const { MeiliSearch } = await import("meilisearch");
      const query = container.resolve(ContainerRegistrationKeys.QUERY) as any;

      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
      });

      // 2. Load ALL customers into RAM — query.graph does a single JOIN (no N+1)
      const t0 = Date.now();
      console.log("📥 Loading all customers into RAM (single query)...");
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
          "metadata",
          "created_at",
          "updated_at",
          "customer_groups.name",
        ],
        pagination: { take: 50000 },
      });
      console.log(
        `✅ Loaded ${customers.length} customers from DB in ${Date.now() - t0}ms`
      );

      // 3. Transform ALL documents in RAM (no I/O, pure CPU)
      const docs = customers.map((c: any) => {
        const meta = (c.metadata as Record<string, any>) ?? {};
        const groupNames: string[] =
          c.customer_groups?.map((g: any) => g.name) ?? [];
        // Source of truth for price_level = customer groups (not metadata)
        const price_level = groupNames.includes("Wholesale")
          ? "Wholesale"
          : "Retail";
        const customer_type =
          meta.qb_customer_type ?? meta.customer_type ?? "Standard";
        return {
          id: c.id,
          email: (c.email ?? "").toLowerCase(),
          first_name: c.first_name ?? "",
          last_name: c.last_name ?? "",
          company_name: c.company_name ?? "",
          phone: c.phone ?? "",
          has_account: c.has_account ?? false,
          status: c.has_account ? "Registered" : "Guest",
          list_id: meta.qb_list_id ?? "",
          acquisition_channel: meta.acquisition_channel ?? "",
          customer_type,
          price_level,
          groups: groupNames,
          updated_at: new Date(c.updated_at).getTime(),
          created_at: new Date(c.created_at).getTime(),
        };
      });
      console.log(`🔄 Transformed ${docs.length} documents in RAM`);

      // 4. Safe upsert + orphan cleanup (replaces destructive delete-all).
      const result = await safeSyncIndex({
        client,
        indexName: "customers",
        primaryKey: "id",
        docs,
        settings: {
          filterableAttributes: [
            "customer_type",
            "price_level",
            "has_account",
            "groups",
          ],
          sortableAttributes: [
            "company_name",
            "created_at",
            "updated_at",
            "email",
          ],
          searchableAttributes: [
            "company_name",
            "email",
            "list_id",
            "first_name",
            "last_name",
            "phone",
          ],
          rankingRules: [
            "words",
            "typo",
            "proximity",
            "attribute",
            "exactness",
            "sort",
          ],
          pagination: { maxTotalHits: 20000 },
        },
        logger: {
          info: (m) => console.log(m),
          warn: (m) => console.warn(m),
          error: (m) => console.error(m),
        },
      });

      isSyncing = false;
      console.log("🔓 Released Sync Lock");

      return new StepResponse({
        success: true,
        message: "Sync completed successfully",
        synced: result.upserted,
        orphansDeleted: result.orphansDeleted,
        totalInIndex: result.totalInIndex,
        durationMs: result.durationMs,
      });
    } catch (error: any) {
      isSyncing = false;
      console.error("❌ Sync Workflow Error:", error);
      throw new Error(`Workflow failed: ${error.message}`);
    }
  }
);

export const syncCustomersWorkflow = createWorkflow(
  "sync-customers-workflow",
  () => {
    const result = syncCustomersToMeiliStep();
    return new WorkflowResponse(result);
  }
);
