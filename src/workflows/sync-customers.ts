import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk";
import { Modules } from "@medusajs/utils";

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
      const customerModule = container.resolve(Modules.CUSTOMER) as any;

      const client = new MeiliSearch({
        host: process.env.MEILISEARCH_HOST!,
        apiKey: process.env.MEILISEARCH_API_KEY!,
      });
      const index = client.index("customers");

      // 1. Update index settings (once per sync)
      await index.updateSettings({
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
        pagination: { maxTotalHits: 20000 },
      });

      // 2. Load ALL customers into RAM in a single DB query
      const t0 = Date.now();
      console.log("📥 Loading all customers into RAM (single query)...");
      const [customers] = await customerModule.listAndCountCustomers(
        {},
        {
          take: 50000,
          select: [
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
          ],
          relations: ["groups"],
        }
      );
      console.log(
        `✅ Loaded ${customers.length} customers from DB in ${Date.now() - t0}ms`
      );

      // 3. Transform ALL documents in RAM (no I/O, pure CPU)
      const docs = customers.map((c: any) => {
        const meta = (c.metadata as Record<string, any>) ?? {};
        const groupNames: string[] = c.groups?.map((g: any) => g.name) ?? [];
        // Source of truth for price_level = customer groups (not metadata)
        const price_level = groupNames.includes("Wholesale")
          ? "Wholesale"
          : "Retail";
        const customer_type =
          meta.qb_customer_type ?? meta.customer_type ?? "Standard";
        return {
          id: c.id,
          email: c.email ?? "",
          first_name: c.first_name ?? "",
          last_name: c.last_name ?? "",
          company_name: c.company_name ?? "",
          phone: c.phone ?? "",
          has_account: c.has_account ?? false,
          status: c.has_account ? "Registered" : "Guest",
          list_id: meta.qb_list_id ?? "",
          customer_type,
          price_level,
          groups: groupNames,
          updated_at: new Date(c.updated_at).getTime(),
          created_at: new Date(c.created_at).getTime(),
        };
      });
      console.log(`🔄 Transformed ${docs.length} documents in RAM`);

      // 4. Atomic clear — wait for completion before uploading
      // (prevents race condition where async delete wipes freshly uploaded docs)
      console.log("🗑️  Clearing index (waiting for completion)...");
      const deleteTask = await index.deleteAllDocuments();
      await client.tasks.waitForTask(deleteTask.taskUid);
      console.log("✅ Index cleared");

      // 5. Upload ALL chunks in parallel (no sequential waiting)
      const CHUNK = 1000;
      const chunks: (typeof docs)[] = [];
      for (let i = 0; i < docs.length; i += CHUNK) {
        chunks.push(docs.slice(i, i + CHUNK));
      }

      console.log(`🚀 Uploading ${chunks.length} chunks in parallel...`);
      const t1 = Date.now();
      const uploadTasks = await Promise.all(
        chunks.map((chunk) => index.addDocuments(chunk, { primaryKey: "id" }))
      );
      // Wait for all Meili tasks to complete
      await Promise.all(
        uploadTasks.map((task) => client.tasks.waitForTask(task.taskUid))
      );
      console.log(
        `✅ Synced ${docs.length} customers to MeiliSearch in ${Date.now() - t1}ms`
      );

      isSyncing = false;
      console.log("🔓 Released Sync Lock");

      return new StepResponse({
        success: true,
        message: "Sync completed successfully",
        synced: docs.length,
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
