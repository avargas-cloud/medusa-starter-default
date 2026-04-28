/**
 * POST /admin/factory-orders/:id/submit
 * Transitions a FO from `draft` to `submitted` via submitFactoryOrderWorkflow.
 */

import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { submitFactoryOrderWorkflow } from "../../../../../workflows/factory-orders/submit-factory-order";
import { getActorUserId, UnauthenticatedError } from "../../_lib/auth";
import { getFactoryOrdersService } from "../../_lib/service-resolver";

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let userId: string;
  try {
    userId = getActorUserId(req);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code });
    }
    throw err;
  }

  const { id } = req.params as { id: string };
  const service = getFactoryOrdersService(req);

  const fo = (await service
    .retrieveFactoryOrder(id)
    .catch(() => null)) as { id: string; status: string } | null;
  if (!fo) {
    return res
      .status(404)
      .json({ error: "Factory order not found", code: "not_found" });
  }
  if (fo.status !== "draft") {
    return res.status(409).json({
      error: `Only drafts can be submitted (current status: ${fo.status}).`,
      code: "not_submittable",
    });
  }

  try {
    const { result } = await submitFactoryOrderWorkflow(req.scope).run({
      input: { fo_id: id, submitted_by_user_id: userId },
    });
    return res.json({ submit: result });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to submit factory order";
    return res.status(400).json({ error: message, code: "submit_failed" });
  }
}
