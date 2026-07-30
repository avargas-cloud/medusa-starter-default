import { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/utils";
import { requireBridgeUrl } from "../../../lib/quickbooks/bridge-url";

const BRIDGE_URL = requireBridgeUrl();
const API_KEY = process.env.QB_API_KEY;

export default async function ({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  // First, find a QB-linked variant with known quickbooks_id
  const { data: variants } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "metadata"],
    filters: { sku: "MG-M100L12DC" },
  });

  const qbId = variants[0]?.metadata?.quickbooks_id;
  logger.info(`Fetching QB item for ListID: ${qbId}`);

  // Fetch just this item from the bridge via products endpoint and look at SalesDesc
  const initRes = await fetch(`${BRIDGE_URL}/api/products`, {
    headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
  });
  const { operationId } = (await initRes.json()) as any;
  logger.info(`Operation: ${operationId}`);

  // Poll once after 30s
  await new Promise((r) => setTimeout(r, 31000));
  const statusRes = await fetch(
    `${BRIDGE_URL}/api/sync/status/${operationId}`,
    {
      headers: { "x-api-key": API_KEY, "bypass-tunnel-reminder": "true" },
    }
  );
  const statusJson: any = await statusRes.json();

  if (statusJson.operation?.status === "completed") {
    const queryRs =
      statusJson.operation?.result?.QBXML?.QBXMLMsgsRs?.ItemQueryRs;
    const items = queryRs?.ItemInventoryRet || [];
    const arr = Array.isArray(items) ? items : [items];

    // Find the specific item
    const target = arr.find((i: any) => i.ListID === qbId);
    if (target) {
      logger.info(`✅ Found item. Keys: ${Object.keys(target).join(", ")}`);
      logger.info(`SalesDesc: ${JSON.stringify(target.SalesDesc)}`);
      logger.info(`SalesPrice: ${target.SalesPrice}`);
      logger.info(`Name: ${target.Name}`);
      // Print full item for inspection
      logger.info(
        `Full item: ${JSON.stringify(target, null, 2).substring(0, 2000)}`
      );
    } else {
      logger.warn(`Item not found for ListID ${qbId}`);
      logger.info(`Sample item keys: ${Object.keys(arr[0] || {}).join(", ")}`);
      logger.info(
        `Sample: ${JSON.stringify(arr[0], null, 2).substring(0, 1000)}`
      );
    }
  } else {
    logger.warn(`Status: ${statusJson.operation?.status}`);
  }
}
