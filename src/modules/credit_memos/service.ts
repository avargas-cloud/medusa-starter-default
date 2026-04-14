import { MedusaService } from "@medusajs/utils";

import PosCreditMemo from "./models/pos-credit-memo";
import PosCreditMemoItem from "./models/pos-credit-memo-item";

class CreditMemoModuleService extends MedusaService({
  PosCreditMemo,
  PosCreditMemoItem,
}) {}

export default CreditMemoModuleService;
