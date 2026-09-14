/**
 * repost-payment-surcharge.ts — re-postea al GL los cobros con surcharge.
 *
 * `replay-gl` sólo postea documentos SIN asiento activo, así que los cobros
 * backfilleados (`fix/backfill-payment-surcharge.ts`) conservan su asiento
 * viejo de 2 líneas. Para cada `customer_payment` con `surcharge_cents > 0`
 * cuyo asiento activo NO tiene la línea `credit_card_surcharge`: reversa el
 * asiento (kind reversal, queda la pista) y lo vuelve a postear con las 3
 * líneas, el MISMO día de negocio. Cada cobro va en su propio SAVEPOINT; en
 * dry-run se revierte siempre (idéntico a `replayLedger`).
 *
 * Uso:
 *   ./node_modules/.bin/tsx src/scripts/ledger/repost-payment-surcharge.ts [--limit N] [--apply]
 *
 * `--apply` se RECHAZA salvo DATABASE_URL sandbox (':5499/') o
 * GL_REPLAY_ALLOW_PROD=1 — misma regla que replay-gl.
 */
import { Pool } from "pg";

import {
  postCustomerPayment,
  reverseCustomerPayment,
} from "../../lib/ledger/documents/customer-payment";
import { LedgerError } from "../../lib/ledger/types";

const ACTOR = "ledger-surcharge-repost";

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const PENDING_SQL = `
  SELECT p.id, p.received_at::text, p.surcharge_cents
  FROM customer_payment p
  JOIN bank_journal_entry e ON e.kind = 'document' AND e.source_kind = 'customer_payment'
    AND e.source_id = p.id AND e.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id AND r.deleted_at IS NULL)
  WHERE p.deleted_at IS NULL AND p.type = 'payment' AND p.surcharge_cents > 0
    AND NOT EXISTS (SELECT 1 FROM bank_journal_line l WHERE l.entry_id = e.id AND l.role = 'credit_card_surcharge' AND l.deleted_at IS NULL)
  ORDER BY p.received_at, p.id
  LIMIT $1`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("repost-payment-surcharge: DATABASE_URL no está seteada.");
    process.exit(1);
    return;
  }
  const apply = process.argv.includes("--apply");
  const limit = Number(arg("limit") ?? 5000);
  const isSandbox = url.includes(":5499/");
  if (apply && !isSandbox && process.env.GL_REPLAY_ALLOW_PROD !== "1") {
    console.error(
      "repost-payment-surcharge: --apply rechazado — DATABASE_URL no es sandbox y GL_REPLAY_ALLOW_PROD no está seteada."
    );
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const counts = { reposted: 0, blocked: 0 };
  const blocked: Array<{ id: string; code: string }> = [];
  let surchargeCents = 0;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; surcharge_cents: number }>(PENDING_SQL, [limit]);
    console.log(`repost-payment-surcharge: ${rows.length} cobros pendientes (${apply ? "APPLY" : "dry-run"})`);
    for (const row of rows) {
      const sp = `sp_${Math.random().toString(36).slice(2, 12)}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        const reversed = await reverseCustomerPayment(client, row.id, ACTOR, "surcharge repost");
        if (reversed.status !== "reversed") throw new LedgerError("GL_SOURCE_INVALID", { reversed: reversed.status });
        const posted = await postCustomerPayment(client, row.id, ACTOR);
        if (posted.status !== "posted") throw new LedgerError("GL_SOURCE_INVALID", { posted: posted.status });
        const { rows: lines } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM bank_journal_line WHERE entry_id = $1 AND role = 'credit_card_surcharge' AND credit_cents = $2`,
          [posted.entry_id, row.surcharge_cents]
        );
        if (lines[0]?.n !== "1") throw new LedgerError("GL_SOURCE_INVALID", { surcharge_line: lines[0]?.n });
        counts.reposted++;
        surchargeCents += Number(row.surcharge_cents);
        if (apply) await client.query(`RELEASE SAVEPOINT ${sp}`);
        else await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        counts.blocked++;
        if (blocked.length < 25)
          blocked.push({ id: row.id, code: err instanceof LedgerError ? `${err.code} ${JSON.stringify(err.details ?? {})}` : String(err) });
      }
    }
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`reposted: ${counts.reposted} · surcharge total: $${(surchargeCents / 100).toFixed(2)} · blocked: ${counts.blocked}`);
  for (const b of blocked) console.log(`  BLOCKED ${b.id}: ${b.code}`);
  if (counts.blocked > 0) process.exit(1);
}

void main();
