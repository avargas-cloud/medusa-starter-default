import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { z } from "zod";

import { reviewAccess } from "../../../../lib/banking/review-permissions";
import { bankingTransactions } from "../../../../lib/banking/views";
import { bankBody, bankFailure, bankId } from "../_lib/http";

const integerQuery = (
  max: number,
  fallback: number,
  minimum = 0
): z.ZodType<number> =>
  z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    // zod v4: `.default()` recibe la SALIDA del schema (number), no la entrada
    // (string) como en v3. Ausente el parámetro, devuelve `fallback` sin pasar
    // por el pipe — mismo valor efectivo que antes.
    .pipe(z.number().int().min(minimum).max(max))
    .default(fallback);
const query = z.object({
  account_id: bankId,
  status: z.enum(["pending", "posted", "removed"]).optional(),
  offset: integerQuery(Number.MAX_SAFE_INTEGER, 0),
  limit: integerQuery(100, 50, 1),
  review_status: z
    .enum(["all", "pending", "confirmed", "excluded", "closed"])
    .default("all"),
  q: z.string().max(200).default(""),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(validDate)
    .optional(),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(validDate)
    .optional(),
  history: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T12:00:00Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<MedusaResponse> {
  try {
    await reviewAccess(req);
    const filters = bankBody(query, req.query);
    if (
      filters.date_from &&
      filters.date_to &&
      filters.date_from > filters.date_to
    ) {
      return res.status(400).json({
        error: "BANKING_INVALID_DATE_RANGE",
        code: "BANKING_INVALID_DATE_RANGE",
      });
    }
    return res.json(await bankingTransactions(filters));
  } catch (error) {
    return bankFailure(res, error);
  }
}
