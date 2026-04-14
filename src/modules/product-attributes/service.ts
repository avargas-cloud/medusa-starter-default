import { MedusaService } from "@medusajs/utils";

import { AttributeKey } from "./models/attribute-key";
import { AttributeSet } from "./models/attribute-set";
import { AttributeValue } from "./models/attribute-value";

class ProductAttributesModuleService extends MedusaService({
  AttributeKey,
  AttributeValue,
  AttributeSet,
}) {}

export default ProductAttributesModuleService;
