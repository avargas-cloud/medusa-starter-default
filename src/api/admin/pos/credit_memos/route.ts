import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/utils";

import { CREDIT_MEMO_MODULE } from "../../../../modules/credit_memos";
import CreditMemoModuleService from "../../../../modules/credit_memos/service";

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const logger = req.scope.resolve("logger");
  const creditMemoService: CreditMemoModuleService =
    req.scope.resolve(CREDIT_MEMO_MODULE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customerModule = req.scope.resolve(Modules.CUSTOMER) as any;
  const { skip = "0", take = "200" } = req.query as Record<string, string>;

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

    // Enrich with customer data in a single batch query
    const customerIds = [...new Set(
      creditMemos.map((m: any) => m.customer_id).filter(Boolean)
    )];
    const customers = customerIds.length
      ? await customerModule.listCustomers(
          { id: customerIds },
          { select: ["id", "first_name", "last_name", "email", "phone", "company_name"] }
        )
      : [];
    const customerMap = Object.fromEntries(customers.map((c: any) => [c.id, c]));
    const enriched = creditMemos.map((m: any) => ({
      ...m,
      customer: customerMap[m.customer_id] ?? null,
    }));

    res.status(200).json({ credit_memos: enriched, count });
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
