import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { addReviewAttachment } from "../../../../../../lib/banking/review-attachments";
import { bankBody, bankFailure } from "../../../_lib/http";
import {
  reviewCommandRequest,
  reviewVersions,
} from "../../../_lib/review-http";
const bodySchema = reviewVersions
  .extend({
    name: z.string().min(1).max(200),
    mime_type: z.literal("application/pdf"),
    content_base64: z.string().min(4).max(6990508),
  })
  .strict();
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    const { id, actorId, key } = await reviewCommandRequest(req);
    return res.json(
      await addReviewAttachment(
        id,
        actorId,
        key,
        bankBody(bodySchema, req.body)
      )
    );
  } catch (error) {
    return bankFailure(res, error);
  }
}
