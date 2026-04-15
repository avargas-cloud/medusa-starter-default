import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import { CREDIT_MEMO_MODULE } from "../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../modules/credit_memos/service";

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger");
  const creditMemoService: CreditMemoModuleService =
    req.scope.resolve(CREDIT_MEMO_MODULE);
  const { skip = "0", take = "100" } = req.query as Record<string, string>;

  try {
    const [creditMemos, count] =
      await creditMemoService.listAndCountPosCreditMemos(
        {},
        {
          skip: parseInt(skip),
          take: parseInt(take),
          relations: ["items"],
        }
      );

    res.status(200).json({ credit_memos: creditMemos, count });
  } catch (e: any) {
    logger.error(`[credit_memos list GET] failed: ${e.message}`, e);
    const keys = Object.keys(creditMemoService || {}).filter((k) =>
      k.includes("list")
    );
    res.status(500).json({
      success: false,
      message: e.message,
      stack: e.stack,
      availableMethods: keys,
    });
  }
}
