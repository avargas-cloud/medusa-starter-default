import { MedusaService } from "@medusajs/utils";

import PosCreditMemo from "./models/pos-credit-memo";
import PosCreditMemoItem from "./models/pos-credit-memo-item";

const BaseService = MedusaService({ PosCreditMemo, PosCreditMemoItem });

// Medusa's type generator pluralizes "PosCreditMemo" → "PosCreditMemoes",
// but the runtime `pluralize` package generates "PosCreditMemos".
// We declare the runtime names as aliases of the TS-declared ones so both
// the compiler and the JS runtime agree — no `any`, no runtime overhead.
class CreditMemoModuleService extends BaseService {
  declare listAndCountPosCreditMemos: InstanceType<
    typeof BaseService
  >["listAndCountPosCreditMemoes"];

  declare listPosCreditMemos: InstanceType<
    typeof BaseService
  >["listPosCreditMemoes"];
}

export default CreditMemoModuleService;
