import { BankingError, requireBankingEnabled } from "./security";

/** Closed host table: the environment is chosen by configuration, never by a request. */
const HOSTS = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" } as const;

const PATHS = new Set([
  "/link/token/create", "/item/public_token/exchange", "/accounts/get", "/item/get",
  "/institutions/get_by_id", "/transactions/sync", "/transactions/refresh",
  "/item/remove", "/webhook_verification_key/get",
]);

/** Host from the closed table above and a fixed endpoint allowlist; no route can initiate payments. */
export async function plaidRequest(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const environment = requireBankingEnabled();
  if (!PATHS.has(path)) throw new BankingError("BANKING_ENDPOINT_NOT_ALLOWED");
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = environment === "production" ? process.env.PLAID_PRODUCTION_SECRET : process.env.PLAID_SANDBOX_SECRET;
  if (!clientId || !secret) throw new BankingError("BANKING_PLAID_NOT_CONFIGURED", 503);
  let response: Response;
  try {
    response = await fetch(`${HOSTS[environment]}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
      body: JSON.stringify({ ...payload, client_id: clientId, secret }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch { throw new BankingError("BANKING_PROVIDER_UNREACHABLE", 502); }
  let result: Record<string, unknown>;
  try { result = object(await response.json()); }
  catch { throw new BankingError("BANKING_PROVIDER_INVALID_RESPONSE", 502); }
  if (!response.ok) {
    const code = typeof result.error_code === "string" && /^[A-Z0-9_]{1,80}$/.test(result.error_code)
      ? result.error_code : "BANKING_PROVIDER_ERROR";
    throw new BankingError(code, 502);
  }
  return result;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BankingError("BANKING_PROVIDER_INVALID_RESPONSE", 502);
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 10000) throw new BankingError("BANKING_PROVIDER_INVALID_RESPONSE", 502);
  return value;
}
export function nullableString(value: unknown): string | null {
  return value == null ? null : string(value);
}
export function decimal(value: unknown): string {
  if (typeof value !== "number" && typeof value !== "string") throw new BankingError("BANKING_INVALID_AMOUNT", 502);
  const result = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(result) || result.length > 40) throw new BankingError("BANKING_INVALID_AMOUNT", 502);
  return result;
}
export function date(value: unknown): string {
  const result = string(value);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new BankingError("BANKING_INVALID_DATE", 502);
  }
  return result;
}
