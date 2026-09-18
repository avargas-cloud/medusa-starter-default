/**
 * e2e-cash-close-sandbox.ts — SANDBOX ONLY (aborts unless DATABASE_URL is
 * :5499/localhost). Exercises the whole Cash Close write path against a
 * real Postgres: create an unexplained payment → compute (not balanced) →
 * createCashClose must refuse (CASH_CLOSE_NOT_BALANCED) → hold it as a
 * deposit via `lib/cash-close/service.ts#holdPayment` (the same function the
 * HTTP route calls) → compute again (balanced) → create (gets a CC-#### and
 * `snapshot.totals.held_deposit_cents` = the held amount) → create AGAIN for
 * the same day (new number, the first record's `superseded_by` now points
 * at it) → cleanup (only the rows this script created, by id).
 *
 * Usage:
 *   env DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-cash-close-sandbox.ts
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

import {
  CashCloseNotBalancedError,
  computeCashClose,
  createCashClose,
  holdPayment,
} from "../../lib/cash-close/service";
import type { Knexish } from "../../lib/cash-close/load-day";
import { latestClosableDay } from "../../lib/cash-close/service";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name} — ${detail}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} — ${detail}`);
  }
}

/** `?`-placeholder adapter over a plain pg Pool — same shape `Knexish`
 * expects from `container.resolve("__pg_connection__")` in production, so
 * `computeCashClose`/`createCashClose`/`holdPayment` run unmodified here. */
function poolAsKnexish(pool: Pool): Knexish {
  const toDollarParams = (sql: string): string => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  return {
    raw: async <T>(sql: string, params: unknown[] = []) => {
      const { rows } = await pool.query<T & Record<string, unknown>>(
        toDollarParams(sql),
        params
      );
      return { rows: rows as T[] };
    },
    transaction: async <R>(fn: (trx: Knexish) => Promise<R>) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const trx: Knexish = {
          raw: async <T>(sql: string, params: unknown[] = []) => {
            const { rows } = await client.query<T & Record<string, unknown>>(
              toDollarParams(sql),
              params
            );
            return { rows: rows as T[] };
          },
          transaction: () => {
            throw new Error("nested transaction not supported by this adapter");
          },
        };
        const result = await fn(trx);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/127\.0\.0\.1:5499|localhost:5499/.test(url)) {
    console.error(
      `ABORT: DATABASE_URL no apunta al sandbox (:5499). Recibido: ${url.replace(/:[^:@]*@/, ":***@")}`
    );
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });
  const knex = poolAsKnexish(pool);

  // A SYNTHETIC past day: the sandbox is a prod copy, so a real day carries
  // other unexplained rows (09/17 has a 5¢ Zelle over-payment) and "balanced
  // after the hold" would never hold. Today is not closable by design (400).
  const day = "2020-01-02";
  if (day > latestClosableDay()) throw new Error("synthetic day must be in the past");
  const customerId = `cus_e2ecashclose${Date.now().toString(36)}`;
  const paymentId = `cpay_e2ecashclose${Date.now().toString(36)}`;
  const actorId = "user_e2e_cash_close";
  const AMOUNT_CENTS = 5000;
  const createdCloseIds: string[] = [];

  try {
    console.log(`\nCash Close E2E — day ${day}\n`);

    await pool.query(
      `INSERT INTO customer (id, first_name, last_name, email) VALUES ($1, 'E2E', 'CashClose', $2)`,
      [customerId, `${customerId}@example.test`]
    );
    await pool.query(
      `INSERT INTO customer_payment
         (id, customer_id, source, type, amount, currency, method, status, received_at, raw_amount, created_at, updated_at)
       VALUES ($1, $2, 'pos', 'payment', $3::numeric, 'usd', 'cash', 'available', ($5::date + time '16:00') AT TIME ZONE 'America/New_York',
               jsonb_build_object('value', $4::text, 'precision', 20), now(), now())`,
      [paymentId, customerId, AMOUNT_CENTS, String(AMOUNT_CENTS), day]
    );

    // ── A. No application at all → the whole amount is unexplained ─────────
    console.log("A. Unapplied cash payment with no hold");
    const s1 = await computeCashClose(knex, day);
    check(
      "unexplained_cents includes our 5000",
      s1.totals.unexplained_cents >= AMOUNT_CENTS,
      `unexplained_cents=${s1.totals.unexplained_cents}`
    );
    check("day is NOT balanced", !s1.balanced, `balanced=${s1.balanced}`);

    // ── B. createCashClose must refuse (409-equivalent) ─────────────────────
    console.log("\nB. create refuses an unbalanced day");
    let refused = false;
    let unexplainedFromError = -1;
    try {
      await createCashClose(knex, { day, actorId });
    } catch (err) {
      if (err instanceof CashCloseNotBalancedError) {
        refused = true;
        unexplainedFromError = err.unexplained_cents;
      } else {
        throw err;
      }
    }
    check("throws CashCloseNotBalancedError", refused, `unexplained_cents=${unexplainedFromError}`);

    // ── C. Hold as deposit via the service function ─────────────────────────
    console.log("\nC. hold the payment as a deposit");
    const hold = await holdPayment(knex, {
      paymentId,
      kind: "deposit",
      note: "e2e fixture",
      actorId,
    });
    check("hold.kind === 'deposit'", hold?.kind === "deposit", `hold=${JSON.stringify(hold)}`);

    const s2 = await computeCashClose(knex, day);
    check("day IS balanced after the hold", s2.balanced, `balanced=${s2.balanced}, unexplained=${s2.totals.unexplained_cents}`);
    check(
      "held_deposit_cents includes our 5000",
      s2.totals.held_deposit_cents >= AMOUNT_CENTS,
      `held_deposit_cents=${s2.totals.held_deposit_cents}`
    );

    // ── D. Create — gets a CC-#### number ────────────────────────────────────
    console.log("\nD. create the close");
    const record1 = await createCashClose(knex, { day, actorId });
    createdCloseIds.push(record1.id);
    check("number matches CC-####", /^CC-\d{4}$/.test(record1.number), `number=${record1.number}`);
    check(
      "snapshot.totals.held_deposit_cents includes our 5000",
      record1.snapshot.totals.held_deposit_cents >= AMOUNT_CENTS,
      `held_deposit_cents=${record1.snapshot.totals.held_deposit_cents}`
    );

    // ── E. Create AGAIN for the same day — new number, old superseded ───────
    console.log("\nE. re-create the same day supersedes the first record");
    const record2 = await createCashClose(knex, { day, actorId });
    createdCloseIds.push(record2.id);
    check(
      "second record has a DIFFERENT number",
      record2.number !== record1.number,
      `first=${record1.number} second=${record2.number}`
    );
    const { rows: supersededRows } = await pool.query<{ superseded_by: string | null }>(
      `SELECT superseded_by FROM pos_cash_close WHERE id = $1`,
      [record1.id]
    );
    check(
      "first record's superseded_by points at the second",
      supersededRows[0]?.superseded_by === record2.id,
      `superseded_by=${supersededRows[0]?.superseded_by}`
    );
  } finally {
    // Cleanup — only the rows THIS script created, by id.
    if (createdCloseIds.length) {
      await pool.query(`DELETE FROM pos_cash_close WHERE id = ANY($1::text[])`, [createdCloseIds]);
    }
    await pool.query(`DELETE FROM customer_payment WHERE id = $1`, [paymentId]);
    await pool.query(`DELETE FROM customer WHERE id = $1`, [customerId]);
    console.log(
      `\nCleanup: removed ${createdCloseIds.length} close(s), 1 payment, 1 customer.`
    );
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
