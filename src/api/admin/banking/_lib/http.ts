import type { MedusaResponse } from "@medusajs/framework/http";
import { z } from "zod";

import { BankingError } from "../../../../lib/banking/security";

export const bankId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

// zod v4 quitó el 3er parámetro `ZodTypeDef` de `z.ZodType`. Inferir la salida
// DESDE el schema (`z.output<S>`) en vez de declararla como parámetro propio
// conserva el tipado en los 38 callers y vale igual en v3 y en v4.
export function bankBody<S extends z.ZodType>(
  schema: S,
  value: unknown
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BankingError("BANKING_INVALID_REQUEST", 400);
  return parsed.data;
}

export function bankFailure(
  res: MedusaResponse,
  error: unknown
): MedusaResponse {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: "BANKING_INVALID_REQUEST",
      code: "BANKING_INVALID_REQUEST",
    });
  }
  // Only the database's explicitly raised Banking invariants are public errors.
  // Never expose SQL text, constraint details or arbitrary driver messages.
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "P0001" &&
    /^BANKING_[A-Z0-9_]{1,72}$/.test(error.message)
  ) {
    return res.status(409).json({ error: error.message, code: error.message });
  }
  const known = error instanceof BankingError;
  if (!known && error instanceof Error) {
    console.error(
      "[banking SQL]",
      "code" in error ? String(error.code) : error.name,
      error.message.replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/g, "$1[REDACTED]@")
    );
    if ("where" in error && typeof error.where === "string")
      console.error(
        "[banking SQL]",
        error.where
          .split("\n")
          .filter((line) => line.startsWith("PL/pgSQL function"))
          .join("; ")
      );
  }
  const code =
    known && /^[A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code
      : "BANKING_OPERATION_FAILED";
  const status =
    known &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : 500;
  return res.status(status).json({ error: code, code });
}
