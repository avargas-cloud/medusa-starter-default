import { MedusaService } from "@medusajs/utils";

import { ProductAlternative } from "./models/product-alternative";
import { PurchasingAnalysisGroup } from "./models/purchasing-analysis-group";
import { PurchasingAnalysisGroupProduct } from "./models/purchasing-analysis-group-product";
import { PurchasingConfig } from "./models/purchasing-config";
import { PurchasingSalesHistory } from "./models/purchasing-sales-history";
import { PurchasingSnapshot } from "./models/purchasing-snapshot";

class PurchasingModuleService extends MedusaService({
  ProductAlternative,
  PurchasingAnalysisGroup,
  PurchasingAnalysisGroupProduct,
  PurchasingConfig,
  PurchasingSnapshot,
  PurchasingSalesHistory,
}) {}

export default PurchasingModuleService;
