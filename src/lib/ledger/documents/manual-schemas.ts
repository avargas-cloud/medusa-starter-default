import { z } from "zod";

import type { BankCheckWriteInput } from "./bank-check";
import type { BankTransferWriteInput } from "./bank-transfer";
import type { JournalEntryWriteInput } from "./journal-entry";
import {
  CENTS_SCHEMA,
  DAY_SCHEMA,
  MEMO_SCHEMA,
  OPTIONAL_ID_SCHEMA,
} from "./manual-http";

/** Bodies zod de los POST/PATCH de documentos manuales + conversión a los inputs (cents → bigint). */

const journalLineSchema = z
  .object({
    account_list_id: z.string().trim().min(1),
    debit_cents: CENTS_SCHEMA.min(0).default(0),
    credit_cents: CENTS_SCHEMA.min(0).default(0),
    memo: MEMO_SCHEMA,
    entity_type: z.enum(["customer", "vendor"]).nullable().optional(),
    entity_id: OPTIONAL_ID_SCHEMA,
    entity_name: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const journalEntryBodySchema = z
  .object({
    day: DAY_SCHEMA,
    memo: MEMO_SCHEMA,
    evidence_id: OPTIONAL_ID_SCHEMA,
    lines: z.array(journalLineSchema).min(2).max(200),
    post: z.boolean().optional(),
  })
  .strict();

export function toJournalEntryInput(
  body: z.infer<typeof journalEntryBodySchema>
): JournalEntryWriteInput {
  return {
    day: body.day,
    memo: body.memo ?? null,
    evidence_id: body.evidence_id ?? null,
    lines: body.lines.map((l) => ({
      ...l,
      debit_cents: BigInt(l.debit_cents),
      credit_cents: BigInt(l.credit_cents),
    })),
  };
}

const checkLineSchema = z
  .object({
    account_list_id: z.string().trim().min(1),
    amount_cents: CENTS_SCHEMA.refine(
      (v) => v !== 0,
      "amount_cents must not be 0"
    ),
    memo: MEMO_SCHEMA,
    customer_id: OPTIONAL_ID_SCHEMA,
    billable: z.boolean().optional(),
  })
  .strict();

export const bankCheckBodySchema = z
  .object({
    day: DAY_SCHEMA,
    bank_account_list_id: z.string().trim().min(1),
    number: z.string().trim().max(50).nullable().optional(),
    payee_type: z.enum(["vendor", "customer", "other"]),
    payee_id: OPTIONAL_ID_SCHEMA,
    payee_name: z.string().trim().min(1).max(500),
    memo: MEMO_SCHEMA,
    to_be_printed: z.boolean().optional(),
    evidence_id: OPTIONAL_ID_SCHEMA,
    lines: z.array(checkLineSchema).min(1).max(199),
    post: z.boolean().optional(),
  })
  .strict();

export function toBankCheckInput(
  body: z.infer<typeof bankCheckBodySchema>
): BankCheckWriteInput {
  return {
    day: body.day,
    bank_account_list_id: body.bank_account_list_id,
    number: body.number ?? null,
    payee_type: body.payee_type,
    payee_id: body.payee_id ?? null,
    payee_name: body.payee_name,
    memo: body.memo ?? null,
    to_be_printed: body.to_be_printed ?? false,
    evidence_id: body.evidence_id ?? null,
    lines: body.lines.map((l) => ({
      ...l,
      amount_cents: BigInt(l.amount_cents),
    })),
  };
}

export const bankTransferBodySchema = z
  .object({
    day: DAY_SCHEMA,
    from_account_list_id: z.string().trim().min(1),
    to_account_list_id: z.string().trim().min(1),
    amount_cents: CENTS_SCHEMA.positive(),
    fee_cents: CENTS_SCHEMA.min(0).optional(),
    fee_account_list_id: OPTIONAL_ID_SCHEMA,
    memo: MEMO_SCHEMA,
    evidence_id: OPTIONAL_ID_SCHEMA,
    post: z.boolean().optional(),
  })
  .strict()
  // `fee_account_list_id` es obligatoria SÓLO si hay fee; el tipo (Expense activa)
  // lo valida el builder contra la base.
  .superRefine((body, ctx) => {
    const fee = body.fee_cents ?? 0;
    if (fee > 0 && !body.fee_account_list_id)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fee_account_list_id"],
        message: "fee_account_list_id is required when fee_cents > 0",
      });
    if (fee >= body.amount_cents)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fee_cents"],
        message: "fee_cents must be below amount_cents",
      });
  });

export function toBankTransferInput(
  body: z.infer<typeof bankTransferBodySchema>
): BankTransferWriteInput {
  return {
    day: body.day,
    from_account_list_id: body.from_account_list_id,
    to_account_list_id: body.to_account_list_id,
    amount_cents: BigInt(body.amount_cents),
    fee_cents: BigInt(body.fee_cents ?? 0),
    fee_account_list_id:
      (body.fee_cents ?? 0) > 0 ? (body.fee_account_list_id ?? null) : null,
    memo: body.memo ?? null,
    evidence_id: body.evidence_id ?? null,
  };
}
