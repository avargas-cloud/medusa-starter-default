/**
 * Re-encrypts every connection token that was written with a key other than the ACTIVE one.
 * Rotation order: publish both keys in BANKING_TOKEN_KEYS_JSON → switch BANKING_TOKEN_ACTIVE_KEY_ID
 * → run this → only then remove the old id from the ring. Compare-and-swap on the ciphertext so a
 * concurrent reconnect never gets overwritten. Explicit entrypoint, never imported by routes/jobs:
 *
 *   node --import ./node_modules/tsx/dist/loader.mjs src/lib/banking/key-rotation.ts [--apply]
 */
import { resolve } from "node:path";
import { getDbPool } from "../../api/utils/db-pool";
import { bankingEnvSql, bankingTokenKey, decryptBankToken, encryptBankToken, envelopeKeyId } from "./security";
import { withBankLock } from "./store";

export async function rotateBankTokens(apply: boolean) {
  const ring = bankingTokenKey();
  const rows = (await getDbPool().query<{ id: string; access_token_encrypted: string }>(
    `SELECT id,access_token_encrypted FROM bank_connection WHERE environment=${bankingEnvSql()}
       AND access_token_encrypted IS NOT NULL AND deleted_at IS NULL ORDER BY id`)).rows;
  const stale = rows.filter(row => envelopeKeyId(row.access_token_encrypted) !== ring.active.id);
  const result = { environment: ring.environment, active: ring.active.id, total: rows.length, stale: stale.length, rotated: 0, skipped: 0 };
  if (!apply) return result;
  for (const row of stale) {
    await withBankLock(row.id, async (client) => {
      const current = (await client.query<{ access_token_encrypted: string | null }>(
        "SELECT access_token_encrypted FROM bank_connection WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (!current?.access_token_encrypted || current.access_token_encrypted !== row.access_token_encrypted) { result.skipped++; return; }
      const token = decryptBankToken(current.access_token_encrypted, row.id, ring);
      const updated = await client.query(`UPDATE bank_connection SET access_token_encrypted=$2,updated_at=now()
        WHERE id=$1 AND access_token_encrypted=$3`, [row.id, encryptBankToken(token, row.id, ring), current.access_token_encrypted]);
      if (updated.rowCount === 1) result.rotated++; else result.skipped++;
    });
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const apply = process.argv.includes("--apply");
  rotateBankTokens(apply)
    .then(result => { console.log(JSON.stringify({ ...result, mode: apply ? "applied" : "dry-run" })); return getDbPool().end(); })
    .catch(error => { console.error("ROTATION_FAILED", error instanceof Error ? error.message : "UNKNOWN"); process.exitCode = 1; });
}
