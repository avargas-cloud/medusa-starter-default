import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
export default async function syncAllCustomers({ container }: ExecArgs) {
  const { transformCustomer, meiliClient, CUSTOMERS_INDEX } =
    await import("../lib/meili-backend.mts");
  const logger = container.resolve("logger");
  const customerModule = container.resolve(Modules.CUSTOMER);

  logger.info(`Starting full customer sync to Meilisearch...`);

  const [customers, count] = await customerModule.listAndCountCustomers(
    {},
    {
      relations: ["groups"],
      take: 10000,
    }
  );

  logger.info(`Found ${count} customers. Transforming...`);

  const docs = customers.map((c) => transformCustomer(c));

  logger.info(`Pushing to Meilisearch...`);
  await meiliClient.index(CUSTOMERS_INDEX).updateDocuments(docs);

  logger.info(`Done!`);
}
