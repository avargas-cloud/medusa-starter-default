import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import {
  getPrimaryPipelineRow,
  type PrimaryPipelineRow,
} from "../../../../lib/quickbooks/get-primary-pipeline-row";
import type { PipelineStep } from "../../../../lib/quickbooks/qb-pipeline";

type DocType = "estimate" | "order" | "invoice" | "credit_memo";

const STEPS_BY_TYPE: Record<DocType, PipelineStep[]> = {
  estimate: ["estimate"],
  order: ["sales_order"],
  // invoices may have been promoted to Sales Receipt or stayed as Invoice
  invoice: ["invoice", "sales_receipt"],
  credit_memo: ["credit_memo"],
};

function isDocType(value: unknown): value is DocType {
  return (
    value === "estimate" ||
    value === "order" ||
    value === "invoice" ||
    value === "credit_memo"
  );
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const referenceId = (req.query.reference_id ?? req.query.id) as
    | string
    | undefined;
  const type = req.query.type;

  if (!referenceId || !isDocType(type)) {
    return res.status(400).json({
      error:
        "Missing or invalid query params. Expected reference_id=<id>&type=estimate|order|invoice|credit_memo",
    });
  }

  const steps = STEPS_BY_TYPE[type];

  // Orders and estimates live as Medusa orders; use the ID as both
  // reference_id and order_id because the subscriber writes order_id.
  const useOrderId = type === "estimate" || type === "order";

  let row: PrimaryPipelineRow | null = null;
  try {
    row = await getPrimaryPipelineRow({
      referenceId: useOrderId ? null : referenceId,
      orderId: useOrderId ? referenceId : null,
      step: steps,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pipeline lookup failed";
    return res.status(500).json({ error: message });
  }

  return res.json({ qb_pipeline: row });
}
