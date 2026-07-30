/**
 * E2E — runs the REAL exported functions against a REAL Postgres.
 *
 * Why this exists as its own thing, separate from the verify-* gates: those call
 * pure functions and grep a file. They never execute a single line of SQL. This
 * repo has already been bitten by exactly that gap — a `uuid = text` comparison
 * inside a `catch` that degraded to a warning, which meant a gate was silently
 * disabled in production while every unit test stayed green. `replaceOrderTaxLines`
 * and `loadLineTaxability` both carry new SQL, and `loadLineTaxability` swallows
 * its errors and returns `{}`, which a caller cannot distinguish from "every line
 * is taxable". So the SQL has to be run, against real Postgres, or it is untested.
 *
 * DESTRUCTIVE: rewrites the tax lines of one order. Sandbox only — the guard
 * below refuses any host/port that is not the sandbox Postgres.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/tests/e2e-order-tax-lines-sandbox.ts
 */
import { Pool } from "pg";

import {
  replaceOrderTaxLines,
  loadLineTaxability,
} from "../../lib/order-money/order-tax-lines";

const SANDBOX_URL =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

const SANDBOX_PORT = "5499";

function assertSandbox(url: string): void {
  // Fail closed. This script DELETEs and INSERTs tax lines; pointing it at
  // Railway would rewrite the tax of a live order.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SANDBOX_DATABASE_URL is not a URL — refusing to run");
  }
  const isLocal = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (!isLocal || parsed.port !== SANDBOX_PORT) {
    throw new Error(
      `refusing to run: ${parsed.hostname}:${parsed.port} is not the sandbox ` +
        `(expected localhost:${SANDBOX_PORT}). This script rewrites tax lines.`
    );
  }
}

type LineRow = {
  item_id: string;
  title: string;
  taxable: boolean | null;
  rate: string | number | null;
  code: string | null;
};

async function snapshot(pool: Pool, orderId: string): Promise<LineRow[]> {
  const r = await pool.query<LineRow>(
    `SELECT oi.item_id, li.title, li.taxable,
            tl.rate, tl.code
       FROM order_item oi
       JOIN order_line_item li ON li.id = oi.item_id
       LEFT JOIN order_line_item_tax_line tl
              ON tl.item_id = oi.item_id AND tl.deleted_at IS NULL
      WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
      ORDER BY li.title, tl.rate`,
    [orderId]
  );
  return r.rows;
}

async function main() {
  assertSandbox(SANDBOX_URL);
  const pool = new Pool({ connectionString: SANDBOX_URL });
  let failures = 0;
  const fail = (m: string) => {
    failures++;
    console.log(`  FAIL  ${m}`);
  };
  const pass = (m: string) => console.log(`  PASS  ${m}`);

  try {
    // Pick an order that actually has BOTH kinds of line. A single-taxability
    // order cannot distinguish the fix from the bug it replaces.
    const pick = await pool.query<{ id: string; doc: string }>(
      `SELECT o.id, o.metadata->>'document_number' AS doc
         FROM "order" o
         JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
         JOIN order_line_item li ON li.id = oi.item_id
        GROUP BY o.id, o.metadata->>'document_number'
       HAVING count(*) FILTER (WHERE li.taxable = false) > 0
          AND count(*) FILTER (WHERE li.taxable IS DISTINCT FROM false) > 0
        ORDER BY count(*) ASC
        LIMIT 1`
    );
    const target = pick.rows[0];
    if (!target) throw new Error("no mixed-taxability order in the sandbox");
    console.log(
      `\nTarget: ${target.doc} (${target.id}) — sandbox ${SANDBOX_URL.replace(/:[^:@]*@/, ":***@")}`
    );

    const before = await snapshot(pool, target.id);
    console.log(`\nBEFORE (${before.length} rows):`);
    for (const r of before) {
      console.log(
        `   ${r.title?.slice(0, 28).padEnd(28)} taxable=${String(r.taxable).padEnd(5)} → ${r.code ?? "(none)"} @ ${r.rate ?? "-"}%`
      );
    }

    // ── 1. loadLineTaxability: does the SQL actually bind and JOIN? ──────────
    // It returns {} on ANY error, so an empty map here is indistinguishable
    // from a broken query. Asserting it is non-empty AND agrees with the DB is
    // the only way to know the catch didn't eat a real failure.
    console.log("\n── 1. loadLineTaxability against real Postgres ──");
    const taxability = await loadLineTaxability(pool, target.id);
    const keys = Object.keys(taxability);
    if (keys.length === 0) {
      fail(
        "returned {} — either the order has no lines or the SQL failed and the catch swallowed it"
      );
    } else {
      pass(`resolved ${keys.length} lines (non-empty ⇒ the SQL ran)`);
      const mismatches = before.filter(
        (r) => taxability[r.item_id] !== (r.taxable !== false)
      );
      if (mismatches.length > 0) {
        fail(
          `${mismatches.length} line(s) disagree with order_line_item.taxable`
        );
      } else {
        pass("every line matches order_line_item.taxable in the DB");
      }
    }

    // ── 2. replaceOrderTaxLines: per-line codes, for real ───────────────────
    console.log("\n── 2. replaceOrderTaxLines @ 7% ──");
    const rewrite = await replaceOrderTaxLines(pool, target.id, 7);
    pass(
      `rewrote ${rewrite.itemIds.length} lines: ${rewrite.taxedItemIds.length} taxed, ${rewrite.exemptItemIds.length} exempt`
    );
    if (rewrite.exemptItemIds.length === 0) {
      fail("no exempt lines classified — the taxable flag never reached the split");
    }

    const after = await snapshot(pool, target.id);
    console.log(`\nAFTER (${after.length} rows):`);
    for (const r of after) {
      console.log(
        `   ${r.title?.slice(0, 28).padEnd(28)} taxable=${String(r.taxable).padEnd(5)} → ${r.code ?? "(none)"} @ ${r.rate ?? "-"}%`
      );
    }

    // Exactly one tax line per line item, and its rate must follow the flag.
    const byItem = new Map<string, LineRow[]>();
    for (const r of after) {
      byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r]);
    }
    let wrongRate = 0;
    let wrongCount = 0;
    for (const [, rows] of byItem) {
      if (rows.length !== 1) wrongCount++;
      const r = rows[0]!;
      const expectedRate = r.taxable === false ? 0 : 7;
      const expectedCode = r.taxable === false ? "EXEMPT" : "FL";
      if (Number(r.rate) !== expectedRate || r.code !== expectedCode) {
        wrongRate++;
        console.log(
          `        ↳ ${r.title}: got ${r.code} @ ${r.rate}%, expected ${expectedCode} @ ${expectedRate}%`
        );
      }
    }
    if (wrongCount > 0) fail(`${wrongCount} line(s) have ≠1 tax line`);
    else pass("exactly one tax line per order line");
    if (wrongRate > 0) fail(`${wrongRate} line(s) carry the wrong rate/code`);
    else pass("every rate and code follows the line's own taxable flag");

    // ── 2b. strict no-op: a second call must not touch anything ─────────────
    // The requirement is that an order already carrying the right tax lines is
    // not moved at all — not "moved to the same values". Re-creating the rows
    // would hand every such order new ids and timestamps, which is a change to
    // records that had nothing wrong with them.
    console.log("\n── 2b. running it again must be a no-op ──");
    const idsBefore = await pool.query<{ id: string; updated_at: string }>(
      `SELECT tl.id, tl.updated_at FROM order_line_item_tax_line tl
        WHERE tl.item_id = ANY($1) AND tl.deleted_at IS NULL ORDER BY tl.id`,
      [rewrite.itemIds]
    );
    await replaceOrderTaxLines(pool, target.id, 7);
    const idsAfter = await pool.query<{ id: string; updated_at: string }>(
      `SELECT tl.id, tl.updated_at FROM order_line_item_tax_line tl
        WHERE tl.item_id = ANY($1) AND tl.deleted_at IS NULL ORDER BY tl.id`,
      [rewrite.itemIds]
    );
    const sameIds =
      idsBefore.rows.length === idsAfter.rows.length &&
      idsBefore.rows.every((r, i) => r.id === idsAfter.rows[i]?.id);
    if (sameIds) pass("second call left every tax-line id untouched");
    else
      fail(
        `second call recreated the rows (${idsBefore.rows.length} → ${idsAfter.rows.length}, ids changed)`
      );

    // ── 2c. a changed rate DOES rewrite ─────────────────────────────────────
    // The no-op must not be so eager that it stops doing its job.
    await replaceOrderTaxLines(pool, target.id, 0);
    const zeroed = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM order_line_item_tax_line tl
        WHERE tl.item_id = ANY($1) AND tl.deleted_at IS NULL AND tl.rate <> 0`,
      [rewrite.itemIds]
    );
    if (Number(zeroed.rows[0]?.n ?? -1) === 0)
      pass("rate change at 0% rewrote every line to EXEMPT");
    else fail(`rate change left ${zeroed.rows[0]?.n} line(s) at a non-zero rate`);
    // Restore the 7% state so the run is repeatable.
    await replaceOrderTaxLines(pool, target.id, 7);

    // ── 3. the old behaviour would have been wrong on this very order ────────
    // Guards against a fix that is a no-op on real data: if a single rate for
    // every line produced the same result here, this order proves nothing.
    console.log("\n── 3. the blind one-rate-for-all would differ here ──");
    const exemptCount = after.filter((r) => r.taxable === false).length;
    if (exemptCount === 0) {
      fail("target order has no exempt line — it cannot demonstrate the fix");
    } else {
      pass(
        `${exemptCount} line(s) would have been stamped FL @ 7% by the old code and are now EXEMPT @ 0%`
      );
    }

    console.log(
      failures === 0
        ? "\n✅ E2E green — the new SQL runs and classifies per line against real Postgres\n"
        : `\n❌ E2E: ${failures} check(s) failed\n`
    );
    if (failures > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`\n❌ E2E aborted: ${e.message}\n`);
  process.exitCode = 1;
});
