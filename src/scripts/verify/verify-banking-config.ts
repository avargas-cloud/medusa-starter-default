/**
 * Runtime gate for the environment a process is ABOUT to serve. Exit ≠ 0 blocks enabling Banking.
 * It resolves the same configuration the API resolves — no separate rules — and reports which
 * variable is missing without printing any value.
 *
 *   node --import ./node_modules/tsx/dist/loader.mjs src/scripts/verify/verify-banking-config.ts
 *   BANKING_ENABLED=true BANKING_ENV=production ... (same env as the deployed service)
 */
import { bankingConfig, requireBankingEnabled, bankingTokenKey, encryptBankToken, decryptBankToken } from "../../lib/banking/security";
import { bankingLimits } from "../../lib/banking/limits";

const config = bankingConfig();
console.log(`environment=${config.environment} enabled=${config.enabled} reason=${config.unavailable_reason ?? "-"} config_error=${config.config_error ?? "-"}`);
if (!config.enabled) {
  console.error(config.environment === "production"
    ? `FAIL: production requested but not enabled — ${config.config_error}`
    : "FAIL: Banking is not enabled in this environment (sandbox needs ECOPOWERTECH_ENV=sandbox; production needs BANKING_ENABLED=true and BANKING_ENV=production)");
  process.exitCode = 1;
} else {
  try {
    const environment = requireBankingEnabled();
    const ring = bankingTokenKey();
    // Round trip through the active key proves the ring is usable without revealing it.
    const probe = decryptBankToken(encryptBankToken("probe", "verify", ring), "verify", ring);
    if (probe !== "probe") throw new Error("ENCRYPTION_ROUNDTRIP_FAILED");
    const limits = bankingLimits();
    console.log(`PASS verify-banking-config: ${environment}; active key ${ring.active.id}; limits ${JSON.stringify(limits)}`);
    if (environment === "production") {
      const names = ["BANKING_EXPECTED_DB_TARGET", "BANKING_WEBHOOK_URL", "BANKING_OAUTH_REDIRECT_URI", "BANKING_TOKEN_ACTIVE_KEY_ID"];
      console.log("production variables present:", names.map(name => `${name}=${process.env[name] ? "set" : "MISSING"}`).join(" "));
    }
  } catch (error) {
    console.error("FAIL verify-banking-config:", error instanceof Error ? error.message : "UNKNOWN");
    process.exitCode = 1;
  }
}
