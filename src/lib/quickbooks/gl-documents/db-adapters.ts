/**
 * db-adapters.ts — puentes entre `pg` y la interfaz knex-style (`?`) que usan
 * `enqueuePurchaseQbOperation` y `loadGlDocumentAddFacts`.
 *
 * Los documentos GL se postean con un `PoolClient` dentro de una transacción
 * (`runInPostingTransaction`), y el pipeline QB habla knex (`raw` con `?`).
 * `resubmit-by-step.ts` ya tiene su `poolAsRawKnex` privado para el caso
 * "Pool sin transacción"; acá viven las dos variantes que este carril
 * necesita, una por origen, para no re-implementar la conversión en cada
 * callsite.
 */

import type { Pool, PoolClient } from "pg";

import type { PurchaseDependencyKnex } from "../../purchase-orders/qb-purchase-dependency-chain";

/** `?` → `$1..$n` (posicional; ningún SQL del carril usa `?` literal). */
export function toPositional(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/**
 * Un `PoolClient` que YA está dentro de una transacción: `transaction()` corre
 * el handler sobre el mismo cliente bajo un SAVEPOINT, así un fallo del
 * enqueue deshace sólo el enqueue y deja que el caller decida.
 */
export function clientInTransactionAsKnex(client: PoolClient): PurchaseDependencyKnex {
  const knex: PurchaseDependencyKnex = {
    raw: async (sql, bindings = []) => {
      const result = await client.query(toPositional(sql), bindings);
      return { rows: result.rows, rowCount: result.rowCount ?? undefined };
    },
    transaction: async (handler) => {
      await client.query("SAVEPOINT gl_document_qb_enqueue");
      try {
        const out = await handler(knex);
        await client.query("RELEASE SAVEPOINT gl_document_qb_enqueue");
        return out;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT gl_document_qb_enqueue");
        throw error;
      }
    },
  };
  return knex;
}

/** Un `Pool` suelto (consolidator): cada `transaction()` toma un cliente y hace BEGIN/COMMIT. */
export function poolAsKnex(pool: Pool): PurchaseDependencyKnex {
  return {
    raw: async (sql, bindings = []) => {
      const result = await pool.query(toPositional(sql), bindings);
      return { rows: result.rows, rowCount: result.rowCount ?? undefined };
    },
    transaction: async (handler) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inner: PurchaseDependencyKnex = {
          raw: async (sql, bindings = []) => {
            const result = await client.query(toPositional(sql), bindings);
            return { rows: result.rows, rowCount: result.rowCount ?? undefined };
          },
        };
        const out = await handler(inner);
        await client.query("COMMIT");
        return out;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
