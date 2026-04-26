import { MedusaService } from "@medusajs/utils";

import { ProductAlternative } from "./models/product-alternative";
import { PurchasingConfig } from "./models/purchasing-config";
import { PurchasingSalesHistory } from "./models/purchasing-sales-history";
import { PurchasingSnapshot } from "./models/purchasing-snapshot";

class PurchasingModuleService extends MedusaService({
  ProductAlternative,
  PurchasingConfig,
  PurchasingSnapshot,
  PurchasingSalesHistory,
}) {}

export default PurchasingModuleService;
