/**
 * repost-vendor-bill-gl — repostea el asiento GL de UN vendor bill (reversa +
 * repost del snapshot actual, `postOrRepostVendorBill`) desde la terminal.
 * Es el mismo motor que corre el drift del reconciler (`lib/ledger/drift.ts`)
 * para un bill puntual, sin esperar a que el barrido lo agarre.
 *
 *   ./node_modules/.bin/tsx src/scripts/ledger/repost-vendor-bill-gl.ts --bill VB-1149 [--apply]
 *
 * Sin `--apply` corre dry-run: imprime el asiento activo actual (día, líneas
 * con cuenta y monto) y hace ROLLBACK sin escribir nada. Con `--apply`
 * COMMITEA y muestra el asiento nuevo.
 *
 * `--apply` se RECHAZA salvo que `DATABASE_URL` apunte al sandbox
 * (`:5499/`) o `GL_REPLAY_ALLOW_PROD=1` esté seteada — mismo guard que
 * `replay-gl.ts` (esa env var NUNCA se setea en este repo, es la señal de
 * un operador que decidió correr contra prod a mano).
 */
import { Pool } from "pg";
import type { QueryResult, QueryResultRow } from "pg";

import { postOrRepostVendorBill } from "../../lib/ledger/documents/vendor-bill";

/** Lo mínimo que comparten `Pool` y `PoolClient` — evita castear entre ellos. */
interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

const ACTOR_ID = "script:repost-vendor-bill-gl";

function arg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface ActiveEntryRow {
  id: string;
  day: string;
  reference: string;
  description: string;
  amount_cents: string;
}

interface ActiveLineRow {
  role: string;
  account_list_id: string;
  account_name: string;
  debit_cents: string;
  credit_cents: string;
}

async function loadActiveEntry(
  db: Queryable,
  billId: string
): Promise<{ entry: ActiveEntryRow; lines: ActiveLineRow[] } | null> {
  const { rows } = await db.query<ActiveEntryRow>(
    `SELECT e.id, e.day::text AS day, e.reference, e.description, e.amount_cents::text
       FROM bank_journal_entry e
      WHERE e.kind = 'document' AND e.source_kind = 'vendor_bill' AND e.source_id = $1
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
      ORDER BY e.created_at DESC
      LIMIT 1`,
    [billId]
  );
  const entry = rows[0];
  if (!entry) return null;
  const { rows: lines } = await db.query<ActiveLineRow>(
    `SELECT l.role, l.account_list_id, (l.account_snapshot->>'name') AS account_name,
            l.debit_cents::text, l.credit_cents::text
       FROM bank_journal_line l
      WHERE l.entry_id = $1
      ORDER BY l.id`,
    [entry.id]
  );
  return { entry, lines };
}

function printEntry(label: string, found: { entry: ActiveEntryRow; lines: ActiveLineRow[] } | null): void {
  console.log(label);
  if (!found) {
    console.log("  (sin asiento activo)");
    return;
  }
  const { entry, lines } = found;
  console.log(
    `  ${entry.id} · ${entry.day} · ${entry.reference} · ${entry.description} · $${(
      Number(entry.amount_cents) / 100
    ).toFixed(2)}`
  );
  for (const line of lines) {
    const amount = line.debit_cents !== "0" ? `DR ${line.debit_cents}` : `CR ${line.credit_cents}`;
    console.log(`    ${line.role} · ${line.account_name ?? line.account_list_id} · ${amount}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("repost-vendor-bill-gl: DATABASE_URL no está seteada.");
    process.exit(1);
    return;
  }

  const billNumber = arg("bill");
  if (!billNumber) {
    console.error("repost-vendor-bill-gl: --bill VB-#### es obligatorio.");
    process.exit(1);
    return;
  }

  const apply = hasFlag("apply");
  const isSandbox = url.includes(":5499/");
  const forceProd = process.env.GL_REPLAY_ALLOW_PROD === "1";
  if (apply && !isSandbox && !forceProd) {
    console.error(
      "repost-vendor-bill-gl: --apply rechazado — DATABASE_URL no apunta al " +
        "sandbox (':5499/') y GL_REPLAY_ALLOW_PROD no está seteada. Esa env var " +
        "NUNCA se setea en este repo; correr contra el sandbox."
    );
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    const { rows: billRows } = await client.query<{ id: string; number: string }>(
      `SELECT id, number FROM vendor_bill WHERE number = $1 AND deleted_at IS NULL`,
      [billNumber]
    );
    const bill = billRows[0];
    if (!bill) throw new Error(`vendor bill no encontrado: ${billNumber}`);

    const before = await loadActiveEntry(pool, bill.id);
    printEntry(`\nAsiento ACTIVO antes (${bill.number}):`, before);

    await client.query("BEGIN");
    try {
      const result = await postOrRepostVendorBill(client, bill.id, ACTOR_ID);
      console.log(`\npostOrRepostVendorBill: ${JSON.stringify(result)}`);

      const after = await loadActiveEntry(client, bill.id);
      printEntry(apply ? "\nAsiento NUEVO (aplicado):" : "\nAsiento que se postearía (dry-run):", after);

      if (apply) {
        await client.query("COMMIT");
        console.log("\nAPPLY: commiteado.");
      } else {
        await client.query("ROLLBACK");
        console.log("\nDRY-RUN: no se escribió nada. Usá --apply.");
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error("repost-vendor-bill-gl:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
