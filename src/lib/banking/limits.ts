import { bankingConfig } from "./security";

/** `null` = no cumulative ceiling. Sandbox keeps the exact historical test caps; production keeps only quotas that bound work. */
export type BankingLimits = {
  connections: number; accounts: number; transactions: number | null;
  syncRuns: number | null; webhookEvents: number | null; batch: number;
};

const SANDBOX: BankingLimits = { connections: 3, accounts: 10, transactions: 2000, syncRuns: 100, webhookEvents: 2000, batch: 10000 };

export function bankingLimits(): BankingLimits {
  if (bankingConfig().environment !== "production") return SANDBOX;
  const configured = Number(process.env.BANKING_MAX_ACTIVE_CONNECTIONS || 25);
  return { connections: configured, accounts: configured * 10, transactions: null, syncRuns: null, webhookEvents: null, batch: 10000 };
}

/** Error codes keep their historical names in sandbox so every existing assertion stays literal. */
export function limitCode(kind: "CONNECTION" | "ACCOUNT" | "TRANSACTION" | "RUN" | "WEBHOOK" | "BATCH"): string {
  return bankingConfig().environment === "production" ? `BANKING_${kind}_LIMIT` : `BANKING_SANDBOX_${kind}_LIMIT`;
}
