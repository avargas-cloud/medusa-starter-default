import { MedusaService } from "@medusajs/utils";

import { QbAccount } from "./models/qb-account";
import { QbItemPipeline } from "./models/qb-item-pipeline";
import { QbVendor } from "./models/qb-vendor";

class QuickbooksCatalogModuleService extends MedusaService({
  QbAccount,
  QbVendor,
  QbItemPipeline,
}) {}

export default QuickbooksCatalogModuleService;
