import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import {
  previewVendorBillConfirmation,
  previewVendorBillRemoval,
  type ProposedVendorBillCost,
} from "../../../../../lib/cost/vendor-bill-replay";
import {
  getActorUserId,
  UnauthenticatedError,
} from "../../../purchase-orders/_lib/auth";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorUserId: string | null;
  try {
    actorUserId = getActorUserId(req) ?? null;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const knex = (
    req.scope as unknown as { resolve: (key: string) => unknown }
  ).resolve("__pg_connection__") as Parameters<
    typeof previewVendorBillRemoval
  >[0];
  const vendorBillId = req.params.id;
  if (!vendorBillId) {
    return res
      .status(400)
      .json({ error: "Vendor bill id is required", code: "missing_id" });
  }

  try {
    const preview = await previewVendorBillRemoval(
      knex,
      vendorBillId,
      actorUserId
    );
    return res.json({
      vendor_bill_id: vendorBillId,
      input_hash: preview.plan.inputHash,
      variants: preview.variantIds.length,
      cost_events: preview.plan.reconciliation.costEvents,
      invoice_lines_changed: preview.plan.reconciliation.invoices.changedLines,
      credit_memo_lines_changed:
        preview.plan.reconciliation.creditMemos.changedLines,
      current_cogs: preview.currentCogs,
      replayed_cogs: preview.replayedCogs,
      cogs_delta: preview.cogsDelta,
      inventory_delta_cents: preview.plan.reconciliation.inventoryDeltaCents,
      exceptions: preview.plan.exceptions,
    });
  } catch (error) {
    return res.status(422).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to preview cost replay",
      code: "cost_replay_preview_failed",
    });
  }
}

export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) {
  let actorUserId: string | null;
  try {
    actorUserId = getActorUserId(req) ?? null;
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return res
        .status(error.status)
        .json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const vendorBillId = req.params.id;
  if (!vendorBillId) {
    return res
      .status(400)
      .json({ error: "Vendor bill id is required", code: "missing_id" });
  }
  const body = req.body as { lines?: ProposedVendorBillCost[] };
  if (!Array.isArray(body.lines)) {
    return res.status(400).json({
      error: "Product cost lines are required",
      code: "invalid_preview_lines",
    });
  }
  const knex = (
    req.scope as unknown as { resolve: (key: string) => unknown }
  ).resolve("__pg_connection__") as Parameters<
    typeof previewVendorBillConfirmation
  >[0];

  try {
    const preview = await previewVendorBillConfirmation(
      knex,
      vendorBillId,
      body.lines,
      actorUserId
    );
    return res.json(preview);
  } catch (error) {
    return res.status(422).json({
      error:
        error instanceof Error
          ? error.message
          : "Unable to preview confirmation costs",
      code: "cost_confirmation_preview_failed",
    });
  }
}
