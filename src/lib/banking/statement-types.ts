import { z } from "zod";
import { reviewDate } from "./review-date";
import { movementId } from "./movement-types";

export const statementCents = z.number().int().min(-999999999999).max(999999999999);
const amount = statementCents.refine(value => value !== 0, "Amount must be nonzero");
export const statementLineSchema = z.object({ external_key: z.string().trim().min(1).max(160), day: reviewDate,
  amount_cents: amount, description: z.string().trim().min(1).max(500), transaction_id: movementId.nullable().default(null) }).strict();
export const statementSaveSchema = z.object({ id: movementId.optional(), expected_revision: z.number().int().nonnegative(),
  bank_account_id: movementId, from: reviewDate, to: reviewDate, reference: z.string().trim().min(1).max(160),
  evidence_id: movementId, opening_balance_cents: statementCents, closing_balance_cents: statementCents,
  declared_line_count: z.number().int().min(0).max(1000), declared_credits_cents: statementCents.nonnegative(),
  declared_debits_cents: statementCents.nonnegative(), completeness_attested: z.boolean(),
  lines: z.array(statementLineSchema).max(1000) }).strict();
export const statementRevisionSchema = z.object({ expected_revision: z.number().int().positive() }).strict();
export const statementMatchSchema = statementRevisionSchema.extend({ allocations: z.array(z.object({
  statement_line_id: movementId, book_kind: z.enum(["journal_line", "opening_item"]), book_id: movementId,
  amount_cents: statementCents.positive(), expected_book_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()).min(1).max(100) });
export const statementUnmatchSchema = statementRevisionSchema.extend({ match_ids: z.array(movementId).min(1).max(100),
  reason: z.string().trim().min(8).max(1000) });
export const statementCloseSchema = statementRevisionSchema.extend({ preview_hash: z.string().regex(/^[a-f0-9]{64}$/) });
export const statementReopenSchema = statementRevisionSchema.extend({ reason: z.string().trim().min(8).max(1000) });
export type StatementInput = z.infer<typeof statementSaveSchema>;
export type StatementLine = z.infer<typeof statementLineSchema> & { id: string; statement_id: string; source_hash: string;
  source_snapshot: Record<string, unknown>; matched_cents: number; remaining_cents: number; blockers: string[] };
export type StatementDocument = Omit<StatementInput, "id" | "expected_revision" | "lines"> & {
  id: string; revision: number; status: "draft" | "closed"; account_list_id: string; opening_id: string;
  predecessor_id: string | null; closed_by: string | null; closed_at: string | null; input_hash: string | null;
  closed_snapshot: StatementSnapshot | null; history: unknown[];
};
export type StatementBookItem = { kind: "journal_line" | "opening_item"; id: string; day: string; reference: string;
  description: string; amount_cents: number; matched_cents: number; remaining_cents: number; source_hash: string;
  transaction_id: string | null; blockers: string[] };
export type StatementMatch = { id: string; statement_line_id: string; book_kind: StatementBookItem["kind"]; book_id: string;
  amount_cents: number; book_hash: string; line_hash: string };
export type StatementOutstanding = { kind: StatementBookItem["kind"]; id: string; amount_cents: number; source_hash: string };
export type StatementSnapshot = { opening_id: string; account_list_id: string; from: string; to: string;
  statement_balance_cents: number; book_balance_cents: number; outstanding: StatementOutstanding[];
  lines: Array<{ id: string; hash: string; amount_cents: number }>; matches: StatementMatch[]; evidence_hash: string };
export type StatementContext = { statement: StatementDocument; lines: StatementLine[]; book_items: StatementBookItem[];
  matches: StatementMatch[]; blockers: string[]; difference_cents: number; book_balance_cents: number;
  deposits_in_transit_cents: number; outstanding_disbursements_cents: number; source_hash: string; needs_review: boolean;
  coverage: "bank_account_period"; global_ledger_coverage: "partial"; zero_gl: true };
