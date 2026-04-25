import { MedusaService } from "@medusajs/utils";

import { ProductAlternative } from "./models/product-alternative";
import { PurchasingConfig } from "./models/purchasing-config";
import { PurchasingSnapshot } from "./models/purchasing-snapshot";
import { PurchasingSalesHistory } from "./models/purchasing-sales-history";

class PurchasingModuleService extends MedusaService({
  ProductAlternative,
  PurchasingConfig,
  PurchasingSnapshot,
  PurchasingSalesHistory,
}) {}

export default PurchasingModuleService;
