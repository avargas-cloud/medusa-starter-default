import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  getPrimaryPipelineRow,
  type PrimaryPipelineRow,
} from "../../../../lib/quickbooks/get-primary-pipeline-row";
import type { PipelineStep } from "../../../../lib/quickbooks/qb-pipeline";

// 1.5.10: extended types so frontend can poll status of any sub-phase 1.5
// pipeline step. Old types kept for backwards compat — clients using
// 'estimate', 'order', 'invoice', 'credit_memo' continue to work; new
// callers can use a step name directly.
type DocType =
  | "estimate"
  | "order"
  | "invoice"
  | "credit_memo"
  | "payment"
  | "apply_payment"
  | "transfer_customer"
  | "so_close"
  | "so_reopen"
  | "estimate_cancel"
  | "credit_memo_mod"
  | "void_credit_memo";

const STEPS_BY_TYPE: Record<DocType, PipelineStep[]> = {
  estimate: ["estimate", "estimate_cancel"],
  order: ["sales_order", "so_close", "so_reopen"],
  // invoices may have been promoted to Sales Receipt or stayed as Invoice
  invoice: ["invoice", "sales_receipt"],
  credit_memo: ["credit_memo", "credit_memo_mod", "void_credit_memo"],
  // direct step polling (1.5.10 additions)
  payment: ["payment"],
  apply_payment: ["apply_payment"],
  transfer_customer: ["transfer_customer"],
  so_close: ["so_close"],
  so_reopen: ["so_reopen"],
  estimate_cancel: ["estimate_cancel"],
  credit_memo_mod: ["credit_memo_mod"],
  void_credit_memo: ["void_credit_memo"],
};

const VALID_DOC_TYPES = Object.keys(STEPS_BY_TYPE) as DocType[];

function isDocType(value: unknown): value is DocType {
  return (
    typeof value === "string" && VALID_DOC_TYPES.includes(value as DocType)
  );
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const referenceId = (req.query.reference_id ?? req.query.id) as
    | string
    | undefined;
  const type = req.query.type;

  if (!referenceId || !isDocType(type)) {
    return res.status(400).json({
      error: `Missing or invalid query params. Expected reference_id=<id>&type=${VALID_DOC_TYPES.join("|")}`,
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
    const message =
      err instanceof Error ? err.message : "pipeline lookup failed";
    return res.status(500).json({ error: message });
  }

  return res.json({ qb_pipeline: row });
}
