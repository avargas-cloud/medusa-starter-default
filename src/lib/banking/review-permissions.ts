import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { getDbPool } from "../../api/utils/db-pool";
import { bankIdentity } from "./auth";
import { bankingConfig, BankingError, requireBankingEnabled } from "./security";
import { appendReviewEvent, reviewCapacity, runReviewCommand } from "./review-common";
import { bankId } from "./store";

export type ReviewCapability = "read" | "review" | "close" | "post" | "manage";
export async function reviewAccess(req: AuthenticatedMedusaRequest, capability: ReviewCapability = "read") {
  const identity = await bankIdentity(req);
  let canReview = identity.canManage;
  let canClose = identity.canManage;
  let canPost = identity.canManage;
  if (!identity.canManage && bankingConfig().enabled) {
    requireBankingEnabled();
    const result = await getDbPool().query<{ can_review: boolean; can_close: boolean; can_post: boolean }>(
      `SELECT can_review,can_close,can_post FROM bank_review_permission WHERE user_id=$1 AND deleted_at IS NULL`,
      [identity.actorId]);
    canReview = result.rows[0]?.can_review === true;
    canClose = result.rows[0]?.can_close === true;
    canPost = result.rows[0]?.can_post === true;
  }
  const allowed = capability === "manage" ? identity.canManage : capability === "review" ? canReview
    : capability === "close" ? canClose : capability === "post" ? canPost
    : identity.canReadAccounting || canReview || canClose || canPost;
  if (!allowed) throw new BankingError("BANKING_ACCESS_DENIED", 403);
  return { actorId: identity.actorId, canManage: identity.canManage, canReview, canClose, canPost };
}

export async function listReviewPermissions() {
  if (!bankingConfig().enabled) return { users: [] };
  requireBankingEnabled();
  const result = await getDbPool().query<{ id: string; email: string; can_review: boolean; can_close: boolean; can_post: boolean }>(
    `SELECT u.id,u.email,COALESCE(p.can_review,false) AS can_review,COALESCE(p.can_close,false) AS can_close,
      COALESCE(p.can_post,false) AS can_post
      FROM "user" u LEFT JOIN bank_review_permission p ON p.user_id=u.id AND p.deleted_at IS NULL
      WHERE u.deleted_at IS NULL ORDER BY u.email,u.id`);
  return { users: result.rows };
}

export async function saveReviewPermission(actorId: string, key: string,
  body: { user_id: string; can_review: boolean; can_close: boolean; can_post?: boolean }) {
  return runReviewCommand({ actorId, key, operation: "permission", entityId: body.user_id, body }, async client => {
    const user = await client.query<{ id: string }>(
      'SELECT id FROM "user" WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [body.user_id]);
    if (!user.rows[0]) throw new BankingError("BANKING_USER_NOT_FOUND", 404);
    const old = await client.query<{ id: string; can_review: boolean; can_close: boolean; can_post: boolean }>(
      "SELECT id,can_review,can_close,can_post FROM bank_review_permission WHERE user_id=$1 FOR UPDATE", [body.user_id]);
    if (!old.rows[0]) await reviewCapacity(client, "bank_review_permission", 25);
    const result = await client.query<{ id: string; user_id: string; can_review: boolean; can_close: boolean; can_post: boolean }>(
      `INSERT INTO bank_review_permission (id,user_id,can_review,can_close,granted_by,can_post)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET
       can_review=EXCLUDED.can_review,can_close=EXCLUDED.can_close,granted_by=EXCLUDED.granted_by,
       can_post=EXCLUDED.can_post,deleted_at=NULL,updated_at=now() RETURNING id,user_id,can_review,can_close,can_post`,
      [old.rows[0]?.id ?? bankId("brp"), body.user_id, body.can_review, body.can_close, actorId,
        body.can_post ?? old.rows[0]?.can_post ?? false]);
    await appendReviewEvent(client, { entity_type: "permission", entity_id: body.user_id,
      action: "permission_saved", actor_id: actorId, details: { before: old.rows[0] ?? null, after: result.rows[0] } });
    return { permission: result.rows[0] };
  });
}
