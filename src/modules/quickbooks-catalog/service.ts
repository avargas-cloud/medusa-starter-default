import { MedusaService } from "@medusajs/utils";

import { QbAccount } from "./models/qb-account";
import { QbAvgCostSyncRun } from "./models/qb-avg-cost-sync-run";
import { QbItemPipeline } from "./models/qb-item-pipeline";
import { QbVendor } from "./models/qb-vendor";
import { QbVendorPipeline } from "./models/qb-vendor-pipeline";
import { QbVendorSyncRun } from "./models/qb-vendor-sync-run";

class QuickbooksCatalogModuleService extends MedusaService({
  QbAccount,
  QbVendor,
  QbItemPipeline,
  QbVendorPipeline,
  QbVendorSyncRun,
  QbAvgCostSyncRun,
}) {}

export default QuickbooksCatalogModuleService;
