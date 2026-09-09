import { z } from "zod";
import { reviewDate } from "./review-date";
import { movementId, movementCents } from "./movement-types";
import type { CompletionLine, CompletionPosting } from "./movement-types";

export const settlementLineSchema = z.object({
  kind: z.enum(["receipt", "refund", "chargeback", "fee", "reserve_hold", "reserve_release"]),
  reference: z.string().trim().min(1).max(160), amount_cents: movementCents,
  source_id: z.string().trim().min(1).max(160), account_list_id: z.string().trim().min(1).max(128),
  evidence_id: movementId, documented_capacity_cents: movementCents.nullable(),
  documented_as_of: reviewDate.nullable(), recognition_owner: z.enum(["existing", "new"]),
  surcharge_cents: z.number().int().min(0).max(999999999999).default(0),
}).strict();
export const settlementSaveSchema = z.object({
  id: movementId.optional(), expected_revision: z.number().int().min(0),
  processor: z.string().trim().min(1).max(100), merchant: z.string().trim().min(1).max(100),
  reference: z.string().trim().min(1).max(160), day: reviewDate,
  bank_account_id: movementId, transaction_id: movementId.nullable().default(null),
  evidence_id: movementId, attested: z.boolean().default(false),
  memo: z.string().trim().max(1000).default(""),
  lines: z.array(settlementLineSchema).min(1).max(100),
}).strict();
export const merchantReceiptSchema = z.object({
  payment_id: movementId, day: reviewDate, evidence_id: movementId,
  clearing_account_list_id: z.string().trim().min(1).max(128),
  ar_account_list_id: z.string().trim().min(1).max(128),
  attested: z.literal(true), expected_source_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type SettlementInput = z.infer<typeof settlementSaveSchema>;
export type SettlementLine = z.infer<typeof settlementLineSchema>;
export type SettlementDocument = Omit<SettlementInput, "id" | "expected_revision"> & {
  id: string; revision: number; created_by: string; created_at: string;
};
export type SettlementTotals = { receipts_cents: number; refunds_cents: number; chargebacks_cents: number;
  fees_cents: number; reserve_held_cents: number; reserve_released_cents: number; net_cents: number;
  surcharge_audit_cents: number };
export type SettlementPreview = { preview_hash: string; source_hash: string; totals: SettlementTotals;
  lines: CompletionLine[]; blockers: string[]; coverage: "partial" };
export type SettlementContext = { settlement: SettlementDocument; postings: CompletionPosting[];
  totals: SettlementTotals; blockers: string[]; coverage: "partial" };
