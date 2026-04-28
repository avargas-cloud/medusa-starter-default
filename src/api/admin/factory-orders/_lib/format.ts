import type { ZodError } from "zod";

export function formatFoNumber(seq: number): string {
  return `FO-${seq}`;
}

export function formatReceiptNumber(seq: number): string {
  return `FRCP-${seq}`;
}

export function zodErrorToBody(err: ZodError): {
  error: string;
  code: "validation_error";
  issues: Array<{ path: string; message: string }>;
} {
  return {
    error: "Invalid request body",
    code: "validation_error",
    issues: err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}
