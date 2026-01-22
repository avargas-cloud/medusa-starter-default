import { MedusaService } from "@medusajs/framework/utils"
import { AttributeKey } from "./models/attribute-key"
import { AttributeValue } from "./models/attribute-value"
import { AttributeSet } from "./models/attribute-set"

class ProductAttributesModuleService extends MedusaService({
    AttributeKey,
    AttributeValue,
    AttributeSet,
}) { }

export default ProductAttributesModuleService
