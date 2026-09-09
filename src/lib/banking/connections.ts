import { createHash } from "node:crypto";
import { BankingError, bankingErrorCode, bankingEnvSql, encryptBankToken, decryptBankToken, bankingTokenKey } from "./security";
import { bankingLimits, limitCode } from "./limits";
import { nullableString, object, plaidRequest, string } from "./plaid";
import { bankId, connectionRow, transaction, withBankLock } from "./store";
import { saveAccounts, selectedAccountRows } from "./accounts";

export async function createLinkToken(actorId: string, connectionId?: string) {
  const key = bankingTokenKey();
  const request: Record<string, unknown> = {
    user: { client_user_id: actorId }, client_name: "EcoPowerTech Store POS",
    country_codes: ["US"], language: "en",
  };
  // Sandbox keeps its optional local variable; production already validated both URLs at configuration time.
  const webhookUrl = key.environment === "production" ? process.env.BANKING_WEBHOOK_URL : process.env.BANKING_SANDBOX_WEBHOOK_URL;
  if (webhookUrl) {
    const url = new URL(webhookUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new BankingError("BANKING_INVALID_WEBHOOK_URL");
    request.webhook = url.toString();
  }
  // OAuth institutions (Chase, Wells Fargo, Amex, PayPal, TD, Regions) return through this registered URI.
  const redirectUri = process.env.BANKING_OAUTH_REDIRECT_URI;
  if (redirectUri) {
    const url = new URL(redirectUri);
    if (url.protocol !== "https:" || url.username || url.password) throw new BankingError("BANKING_INVALID_REDIRECT_URI");
    request.redirect_uri = url.toString();
  }
  if (connectionId) {
    return withBankLock(connectionId, async (client) => {
      const row = await connectionRow(client, connectionId);
      if (!row.access_token_encrypted || row.status === "disconnected") throw new BankingError("BANKING_CONNECTION_DISCONNECTED", 409);
      request.access_token = decryptBankToken(row.access_token_encrypted, connectionId, key);
      const response = await plaidRequest("/link/token/create", request);
      return { link_token: string(response.link_token) };
    });
  }
  request.products = ["transactions"];
  request.account_filters = {
    depository: { account_subtypes: ["checking", "savings", "paypal"] },
    credit: { account_subtypes: ["credit card", "paypal"] },
  };
  request.transactions = { days_requested: 730 };
  const response = await plaidRequest("/link/token/create", request);
  return { link_token: string(response.link_token) };
}

/** Reserve intent before exchange; never blindly repeat an exchange whose outcome was lost. */
export async function connectBank(publicToken: string, actorId: string) {
  const key = bankingTokenKey();
  // Plaid prefixes every token with its environment; a token from the other one is rejected before any exchange.
  const prefix = key.environment === "production" ? "production" : "sandbox";
  if (!publicToken.startsWith(`public-${prefix}-`) || publicToken.length > 500) throw new BankingError("BANKING_SANDBOX_TOKEN_REQUIRED");
  const hash = createHash("sha256").update(publicToken).digest("hex");
  return withBankLock("banking-connect", async (client) => {
    const found = await client.query<{ id: string; access_token_encrypted: string | null }>(
      `SELECT id,access_token_encrypted FROM bank_connection WHERE linked_public_token_hash=$1 AND environment=${bankingEnvSql()}`, [hash]);
    let connectionId = found.rows[0]?.id;
    if (connectionId && !found.rows[0]?.access_token_encrypted) throw new BankingError("BANKING_EXCHANGE_OUTCOME_UNKNOWN", 409);
    if (!connectionId) {
      const count = await client.query<{ count: string }>(`SELECT count(*) FROM bank_connection
        WHERE environment=${bankingEnvSql()} AND status<>'disconnected' AND deleted_at IS NULL`);
      if (Number(count.rows[0]?.count) >= bankingLimits().connections) throw new BankingError(limitCode("CONNECTION"), 409);
      connectionId = bankId("bconn");
      await client.query(`INSERT INTO bank_connection
        (id,provider,environment,provider_item_id,created_by,linked_public_token_hash)
        VALUES($1,'plaid',${bankingEnvSql()},$2,$3,$4)`, [connectionId, `pending:${hash}`, actorId, hash]);
      try {
        const result = await plaidRequest("/item/public_token/exchange", { public_token: publicToken });
        const accessToken = string(result.access_token);
        if (!accessToken.startsWith(`access-${prefix}-`)) throw new BankingError("BANKING_SANDBOX_TOKEN_REQUIRED");
        await client.query(`UPDATE bank_connection SET provider_item_id=$2,access_token_encrypted=$3,updated_at=now()
          WHERE id=$1`, [connectionId, string(result.item_id), encryptBankToken(accessToken, connectionId, key)]);
      } catch {
        await client.query("UPDATE bank_connection SET status='error',last_error_code='BANKING_EXCHANGE_OUTCOME_UNKNOWN',updated_at=now() WHERE id=$1", [connectionId]);
        throw new BankingError("BANKING_EXCHANGE_OUTCOME_UNKNOWN", 409);
      }
    }
    const id = connectionId;
    return withBankLock(id, async (lockedClient) => {
      const connection = await connectionRow(lockedClient, id);
      if (!connection.access_token_encrypted) throw new BankingError("BANKING_CONNECTION_DISCONNECTED", 409);
      try {
        const response = await plaidRequest("/accounts/get", { access_token: decryptBankToken(connection.access_token_encrypted, id, key) });
        const item = object(response.item);
        const institutionId = nullableString(item.institution_id);
        let name = "Connected bank";
        if (institutionId) {
          const result = await plaidRequest("/institutions/get_by_id", { institution_id: institutionId, country_codes: ["US"] });
          name = string(object(result.institution).name);
          const duplicate = await lockedClient.query(`SELECT id FROM bank_connection WHERE institution_id=$1
            AND environment=${bankingEnvSql()} AND status<>'disconnected' AND id<>$2 AND deleted_at IS NULL`, [institutionId, id]);
          if (duplicate.rowCount) throw new BankingError("BANKING_RECONNECT_EXISTING_BANK", 409);
        }
        await transaction(lockedClient, async () => {
          await saveAccounts(lockedClient, id, response.accounts);
          await lockedClient.query(`UPDATE bank_connection SET institution_id=$2,institution_name=$3,
            consent_expiration_time=$4,last_error_code=NULL,updated_at=now() WHERE id=$1`,
          [id, institutionId, name, nullableString(item.consent_expiration_time)]);
        });
        return { connection_id: id, accounts: await selectedAccountRows(lockedClient, id) };
      } catch (error) {
        await lockedClient.query("UPDATE bank_connection SET last_error_code=$2,updated_at=now() WHERE id=$1", [id, bankingErrorCode(error)]);
        throw error;
      }
    });
  });
}
