/**
 * src/lib/ledger-hooks/run-ledger-hook.ts
 *
 * Chokepoint único para los hooks best-effort del General Ledger (plan
 * `gl-core-v1` §6). Cada ruta que lleva un documento a estado terminal llama
 * acá con la llamada al motor (`src/lib/ledger`) ya armada — este helper es el
 * ÚNICO lugar que sabe del feature flag, de cómo se abre/cierra la conexión
 * pg y de cómo se loguea un fallo.
 *
 * Un fallo de posting NUNCA rompe la operación del POS: se loguea
 * `gl.posting_failed` con `source_kind`/`source_id`/`code` y el reconciler
 * (`src/jobs/ledger-reconciler.ts`) lo cura después. Por eso este helper jamás
 * relanza — el caller no tiene `try/catch` que escribir.
 */

import type { PoolClient } from "pg";

import { getDbPool } from "../../api/utils/db-pool";

export interface LedgerHookContext {
  source_kind: string;
  source_id: string;
}

/**
 * Corre `action` contra un `PoolClient` propio, best-effort.
 *
 * No-op (ni siquiera abre conexión) salvo `GL_POSTING_ENABLED === "true"`, tal
 * como especifica el plan: en un ambiente sin la env var, el motor y el job
 * son invisibles.
 *
 * BEGIN/COMMIT explícitos, propios de este helper: `gl_document_check_balance`
 * es un CONSTRAINT TRIGGER `DEFERRABLE INITIALLY DEFERRED` (plan §4) — valida
 * recién al COMMIT de la transacción, sobre entry + TODAS sus líneas. Sin un
 * BEGIN que envuelva el INSERT del entry y el de cada línea, cada `client.query`
 * suelto es su propia transacción implícita: el INSERT del entry se auto-commitea
 * solo, el trigger deferred dispara ahí mismo viendo 0 líneas, y revienta
 * `GL_UNBALANCED_DOCUMENT` — medido contra el sandbox (`e2e-gl-sandbox.ts`)
 * antes de agregar este BEGIN/COMMIT.
 */
export async function runLedgerHook(
  action: (client: PoolClient) => Promise<unknown>,
  context: LedgerHookContext
): Promise<void> {
  if (process.env.GL_POSTING_ENABLED !== "true") return;

  let client: PoolClient | null = null;
  try {
    client = await getDbPool().connect();
    await client.query("BEGIN");
    await action(client);
    await client.query("COMMIT");
  } catch (err: unknown) {
    await client?.query("ROLLBACK").catch(() => {});
    const code =
      (err as { code?: string })?.code ??
      (err as { name?: string })?.name ??
      "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[gl.posting_failed] source_kind=${context.source_kind} source_id=${context.source_id} code=${code}: ${message}`
    );
  } finally {
    client?.release();
  }
}
