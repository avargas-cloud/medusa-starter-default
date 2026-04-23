/**
 * Resincroniza TODOS los customers al índice MeiliSearch 'customers'.
 * Usa la misma lógica que POST /admin/customers/resync-meili pero sin auth.
 *
 * Usage:
 *   yarn medusa exec ./src/scripts/debug/resync-all-customers-meili.ts
 */
import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";

export default async function run({
  container,
}: {
  container: MedusaContainer;
}): Promise<void> {
  const logger = container.resolve("logger") as {
    info: (m: string) => void;
    warn: (m: string) => void;
  };
  const customerModule = container.resolve(Modules.CUSTOMER);

  logger.info("[resync-meili] Fetching all customers with groups...");
  const [customers, total] = await customerModule.listAndCountCustomers(
    {},
    {
      take: null as any,
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
  logger.info(`[resync-meili] Processing ${customers.length}/${total}`);

  const { MeiliSearch } = await import("meilisearch");
  const meili = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });
  const index = meili.index("customers");

  const docs = customers.map((c: any) => {
    const meta = (c.metadata as any) || {};
    const groupNames: string[] = c.groups?.map((g: any) => g.name) || [];
    const price_level = groupNames.includes("Wholesale")
      ? "Wholesale"
      : "Retail";
    const customer_type =
      meta.qb_customer_type || meta.customer_type || "Standard";

    return {
      id: c.id,
      email: c.email,
      first_name: c.first_name || "",
      last_name: c.last_name || "",
      company_name: (c as any).company_name || "",
      phone: c.phone || "",
      has_account: c.has_account,
      status: c.has_account ? "Registered" : "Guest",
      list_id: meta.qb_list_id || "",
      acquisition_channel: meta.acquisition_channel || "",
      customer_type,
      price_level,
      groups: groupNames,
      updated_at: new Date(c.updated_at).getTime(),
      created_at: new Date(c.created_at).getTime(),
    };
  });

  const CHUNK = 500;
  let synced = 0;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const chunk = docs.slice(i, i + CHUNK);
    await index.updateDocuments(chunk);
    synced += chunk.length;
    logger.info(`[resync-meili] ${synced}/${docs.length}`);
  }

  logger.info(
    `[resync-meili] ✅ Done — ${synced} customers sent to MeiliSearch (async task running).`
  );
}
