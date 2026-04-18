import { MedusaContainer } from "@medusajs/framework/types";
import qbItemPipelinePoller from "../../jobs/qb-item-pipeline-poller";

export default async function run({ container }: { container: MedusaContainer }) {
  const logger = container.resolve("logger");
  logger.info("[run-qb-item-pipeline-poller] invoking job function manually");
  await qbItemPipelinePoller(container);
  logger.info("[run-qb-item-pipeline-poller] done");
}
