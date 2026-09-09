import { model } from "@medusajs/utils";

export const BankReviewPermission = model.define("bank_review_permission", {
  id: model.id({ prefix: "bperm" }).primaryKey(),
  user_id: model.text(),
  can_review: model.boolean().default(false),
  can_close: model.boolean().default(false),
  can_post: model.boolean().default(false),
  granted_by: model.text(),
});
