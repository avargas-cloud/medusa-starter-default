import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  getPrimaryPipelineRow,
  type PrimaryPipelineRow,
} from "../../../../lib/quickbooks/get-primary-pipeline-row";
import { getDbPool } from "../../../utils/db-pool";
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
  | "void_credit_memo"
  | "purchase_order";

const STEPS_BY_TYPE: Record<DocType, PipelineStep[]> = {
  estimate: ["estimate", "estimate_cancel"],
  order: ["sales_order", "so_close", "so_reopen"],
  // invoices may have been promoted to Sales Receipt or stayed as Invoice
  invoice: ["invoice", "sales_receipt", "invoice_update", "sales_receipt_update"],
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
  purchase_order: ["purchase_order", "mod_purchase_order", "void_purchase_order"],
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

  if (type === "purchase_order") {
    const pool = getDbPool();
    const { rows } = await pool.query<PrimaryPipelineRow>(
      `SELECT id,
              status,
              CASE
                WHEN (payload->>'is_void')::boolean = true THEN 'void_purchase_order'
                WHEN (payload->>'is_mod')::boolean = true THEN 'mod_purchase_order'
                ELSE 'purchase_order'
              END AS step,
              retries AS retry_count,
              qb_list_id AS qb_txn_id,
              qb_txn_number AS qb_ref_number,
              NULL::text AS medusa_ref_number,
              last_error AS error,
              created_at,
              CASE WHEN status = 'processing' THEN updated_at ELSE NULL END AS submitted_at,
              synced_at AS confirmed_at,
              CASE WHEN status = 'error' THEN updated_at ELSE NULL END AS failed_at
         FROM qb_purchase_order_pipeline
        WHERE purchase_order_id = $1
          AND deleted_at IS NULL
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`,
      [referenceId]
    );
    return res.json({ qb_pipeline: rows[0] ?? null });
  }

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
