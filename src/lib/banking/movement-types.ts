import { z } from "zod";

import type { AccountingAccount } from "./accounting-types";
import { reviewDate } from "./review-date";

export const movementKinds = [
  "obligation_payment",
  "payroll_match",
  "wire_match",
  "refund_match",
  "bank_transfer",
  "credit_card_payment",
  "loan_payment",
  "owner_contribution",
  "owner_withdrawal",
  "advance",
] as const;
export const movementSourceKinds = [
  "vendor_bill",
  "wire",
  "payroll",
  "refund",
  "document",
] as const;
export const movementId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const movementCents = z.number().int().min(1).max(999999999999);
export const movementAllocationSchema = z
  .object({
    role: z.enum(["principal", "interest", "fee"]),
    account_list_id: z.string().trim().min(1).max(128),
    amount_cents: movementCents,
    source_kind: z.enum(movementSourceKinds),
    source_id: z.string().trim().min(1).max(160),
    documented_capacity_cents: movementCents.nullable(),
    documented_as_of: reviewDate.nullable(),
    recognition_owner: z.enum(["existing", "new"]),
    evidence_id: movementId,
  })
  .strict();
export const movementSaveSchema = z
  .object({
    id: movementId.optional(),
    expected_revision: z.number().int().min(0),
    kind: z.enum(movementKinds),
    reference: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(1000),
    day: reviewDate,
    bank_account_id: movementId,
    transaction_id: movementId.nullable().default(null),
    evidence_id: movementId,
    amount_cents: movementCents,
    allocations: z.array(movementAllocationSchema).max(100),
    attested: z.boolean().default(false),
    destination_bank_account_id: movementId.nullable().default(null),
    transit_account_list_id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .nullable()
      .default(null),
  })
  .strict();
export const movementPreviewSchema = z
  .object({ expected_revision: z.number().int().positive() })
  .strict();
export const movementPostSchema = movementPreviewSchema.extend({
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const movementReceivePreviewSchema = movementPreviewSchema.extend({
  day: reviewDate,
  transaction_id: movementId.nullable().default(null),
});
export const movementReceiveSchema = movementReceivePreviewSchema.extend({
  preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const movementReverseSchema = z
  .object({
    posting_id: movementId,
    day: reviewDate,
    reason: z.string().trim().min(8).max(1000),
  })
  .strict();
export const completionEvidenceSchema = z
  .object({
    name: z.string().trim().min(1).max(180),
    mime_type: z.literal("application/pdf"),
    content_base64: z.string().min(1).max(6990508),
  })
  .strict();
export type MovementInput = z.infer<typeof movementSaveSchema>;
export type MovementAllocation = z.infer<typeof movementAllocationSchema>;
export type MovementKind = MovementInput["kind"];
export type MovementSourceKind = MovementAllocation["source_kind"];
export type MovementDocument = Omit<
  MovementInput,
  "id" | "expected_revision"
> & { id: string; revision: number; created_at: string; created_by: string };
export type CompletionLine = {
  role: string;
  account_list_id: string;
  account_snapshot: AccountingAccount;
  debit_cents: number;
  credit_cents: number;
};
export type CompletionClaim = {
  source_kind: string;
  source_id: string;
  amount_cents: number;
  capacity_cents: number;
  source_hash: string;
  source_snapshot: unknown;
};
export type CompletionPosting = {
  id: string;
  kind: string;
  completion_stage: string;
  day: string;
  amount_cents: number;
  reversed_by: string | null;
  source_hash: string;
  lines: CompletionLine[];
};
export type MovementPreview = {
  preview_hash: string;
  source_hash: string;
  stage: "outgoing" | "incoming";
  day: string;
  lines: CompletionLine[];
  amount_cents: number;
  blockers: string[];
  coverage: "partial";
};
export type MovementContext = {
  movement: MovementDocument;
  postings: CompletionPosting[];
  blockers: string[];
  linked_locally_cents: number;
  external_balance: "unknown";
  coverage: "partial";
};
