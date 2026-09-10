/**
 * replay-gl.ts — CLI sobre `replayLedger` (gl-core-v1 §8).
 *
 * Uso:
 *   ./node_modules/.bin/tsx src/scripts/ledger/replay-gl.ts \
 *     --from 2026-04-14 --to 2026-08-31 [--kinds pos_invoice,customer_payment] [--apply]
 *
 * `--apply` se RECHAZA salvo que `DATABASE_URL` apunte al sandbox
 * (`:5499/`) o `GL_REPLAY_ALLOW_PROD=1` esté seteada — y esa env var NUNCA se
 * setea en este repo (regla del plan, no una sugerencia). Sin `--apply` corre
 * dry-run.
 */
import { Pool } from "pg";

import type { LedgerSourceKind } from "../../lib/ledger";
import { replayLedger } from "../../lib/ledger";

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("replay-gl: DATABASE_URL no está seteada.");
    process.exit(1);
    return;
  }

  const from = arg("from");
  const to = arg("to");
  if (!from || !to) {
    console.error("replay-gl: --from y --to son obligatorios (YYYY-MM-DD, ET).");
    process.exit(1);
    return;
  }

  const kindsArg = arg("kinds");
  const kinds = kindsArg
    ? (kindsArg.split(",").map((k) => k.trim()) as LedgerSourceKind[])
    : undefined;

  const apply = hasFlag("apply");
  const isSandbox = url.includes(":5499/");
  const forceProd = process.env.GL_REPLAY_ALLOW_PROD === "1";
  if (apply && !isSandbox && !forceProd) {
    console.error(
      "replay-gl: --apply rechazado — DATABASE_URL no apunta al sandbox " +
        "(':5499/') y GL_REPLAY_ALLOW_PROD no está seteada. Esa env var NUNCA " +
        "se setea en este repo; correr contra el sandbox."
    );
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    // `replayLedger` usa SAVEPOINT por documento — sólo válido dentro de una
    // transacción ya abierta; el BEGIN/COMMIT acá afuera es lo que hace que
    // el trigger DEFERRED de balance vea entry+líneas juntos al final.
    // Default SIN tope: un `--limit` implícito de 200 (el de
    // `ledger-reconciler.ts`, que sí lo pasa explícito a propósito) haría que
    // una corrida manual de este CLI pareciera completa cuando en realidad
    // cortó a mitad del rango — un replay manual pide ver todo lo pedido.
    const limit = arg("limit") ? Number(arg("limit")) : 0;
    await client.query("BEGIN");
    const report = await replayLedger(client, {
      from,
      to,
      kinds,
      apply,
      limit,
    });
    await client.query("COMMIT");

    console.log(`\nreplay-gl: ${from} → ${to}${apply ? " (APPLY)" : " (dry-run)"}`);
    console.log(`limit efectivo: ${limit > 0 ? limit : "sin tope"}`);
    console.log("═".repeat(64));
    printTable(report);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

function printTable(report: unknown): void {
  // El shape exacto de ReplayReport lo define el motor (`src/lib/ledger`);
  // se imprime genérico para no acoplar este CLI a su forma interna.
  const obj = report as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      console.log(`${key}: ${value.length} filas`);
      for (const row of value.slice(0, 50)) {
        console.log(`  ${JSON.stringify(row)}`);
      }
      if (value.length > 50) console.log(`  … ${value.length - 50} más`);
    } else {
      console.log(`${key}: ${JSON.stringify(value)}`);
    }
  }
}

void main();
