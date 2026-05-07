import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ICustomerModuleService } from "@medusajs/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";

/**
 * POST /admin/customers/resync-meili
 *
 * Resyncs all customers (or a batch) to MeiliSearch,
 * writing the correct metadata-backed price_level, list_id, and status.
 *
 * Body params (optional):
 *   limit: number  (default 500, use 0 for all)
 *   offset: number (default 0)
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const customerModule: ICustomerModuleService = req.scope.resolve(
    Modules.CUSTOMER
  );

  const body = req.body as any;
  const limit = body?.limit ?? 500;
  const offset = body?.offset ?? 0;

  try {
    logger.info(
      `[resync-meili] Starting customer MeiliSearch resync (offset=${offset}, limit=${limit || "all"})`
    );

    // Fetch customers with groups
    const [customers, total] = await customerModule.listAndCountCustomers(
      {},
      {
        take: limit || undefined,
        skip: offset,
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

    logger.info(
      `[resync-meili] Processing ${customers.length} customers (total: ${total})`
    );

    const { MeiliSearch } = await import("meilisearch");
    const meili = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST!,
      apiKey: process.env.MEILISEARCH_API_KEY!,
    });
    const index = meili.index("customers");

    // Build docs
    const docs = customers.map((c: any) => {
      const meta = (c.metadata as any) || {};
      const groupNames: string[] = c.groups?.map((g: any) => g.name) || [];
      const price_level =
        meta.qb_price_level ||
        meta.price_level ||
        (groupNames.includes("Wholesale") ? "Wholesale" : "Retail");
      const customer_type =
        meta.qb_customer_type || meta.customer_type || "Standard";

      return {
        id: c.id,
        email: c.email,
        first_name: c.first_name || "",
        last_name: c.last_name || "",
        company_name: meta.company_name || (c as any).company_name || "",
        phone: c.phone || "",
        has_account: c.has_account,
        status: c.has_account ? "Registered" : "Guest",
        list_id: meta.qb_list_id || "",
        acquisition_channel: meta.acquisition_channel || "",
        customer_type,
        price_level,
        default_tax: meta.default_tax || null,
        tax_exempt_reason: meta.tax_exempt_reason || null,
        groups: groupNames,
        updated_at: new Date(c.updated_at).getTime(),
        created_at: new Date(c.created_at).getTime(),
      };
    });

    // Batch update in chunks of 200
    const CHUNK = 200;
    let synced = 0;
    for (let i = 0; i < docs.length; i += CHUNK) {
      const chunk = docs.slice(i, i + CHUNK);
      await index.updateDocuments(chunk);
      synced += chunk.length;
      logger.info(`[resync-meili] Synced ${synced}/${docs.length}`);
    }

    logger.info(
      `[resync-meili] ✅ Done — ${synced} customers synced to MeiliSearch`
    );

    return res.json({
      success: true,
      synced,
      total,
      offset,
      has_more: limit > 0 && offset + customers.length < total,
    });
  } catch (error: any) {
    logger.error(`[resync-meili] ❌ Failed: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
};
