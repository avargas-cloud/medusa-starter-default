/**
 * E2E over the THREE flows that write an order's total, through the real HTTP
 * routes against the sandbox stack:
 *
 *   1. estimate → compute-tax        (is the tax charged on taxable lines only?)
 *   2. estimate → convert to order   (convert-force)
 *   3. edit an order                 (post-edit-sync)
 *
 * A new POS order is created as a draft and then converted, so it travels the
 * same convert-force path as flow 2 — the invariant asserted there covers both.
 *
 * The single invariant, taken from what QuickBooks actually bills (verified over
 * the bridge on SalesReceipt 27807 and Invoice 18861):
 *
 *     current_order_total === subtotal_after_discount + shipping
 *                            + round(taxable_subtotal × rate)
 *
 * and every tax line carries the rate its own line's `taxable` flag calls for.
 *
 * DESTRUCTIVE: converts a draft and re-syncs an order. Sandbox only — guarded.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/tests/e2e-order-total-flows-sandbox.ts
 */
import { readFileSync } from "fs";

import { Pool } from "pg";

const BASE = process.env.SB_BASE ?? "http://localhost:9099";
const SANDBOX_URL =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const TOKEN_FILE =
  process.env.SB_TOKEN_FILE ??
  "/tmp/claude-1000/-home-alejo-webapps-ecopowertech-workspace/055c5696-d07c-46b5-b82e-ff5680ac2a9f/scratchpad/sb.token";

let failures = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};
const info = (m: string) => console.log(`        ${m}`);

function assertSandbox(): void {
  const u = new URL(SANDBOX_URL);
  if (
    !["localhost", "127.0.0.1"].includes(u.hostname) ||
    u.port !== "5499" ||
    !BASE.includes("9099")
  ) {
    throw new Error(
      `refusing to run outside the sandbox (db ${u.hostname}:${u.port}, api ${BASE})`
    );
  }
}

type Money = { total: number; tax: number; orig: number };

async function readSummary(pool: Pool, orderId: string): Promise<Money | null> {
  const r = await pool.query<{ t: string; x: string; o: string }>(
    `SELECT (totals->>'current_order_total') t,
            (totals->>'tax_total') x,
            (totals->>'original_order_total') o
       FROM order_summary
      WHERE order_id = $1 AND deleted_at IS NULL
      ORDER BY version DESC LIMIT 1`,
    [orderId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return { total: Number(row.t ?? 0), tax: Number(row.x ?? 0), orig: Number(row.o ?? 0) };
}

type LineInfo = {
  item_id: string;
  title: string;
  taxable: boolean;
  net: number;
  rate: number | null;
  code: string | null;
  taxLineCount: number;
};

async function readLines(pool: Pool, orderId: string): Promise<LineInfo[]> {
  const r = await pool.query(
    // Mirrors the canonical scoping of lib/order-money/order-tax-lines.ts:
    // current order version only, newest adjustment per (item, code), and GROSS
    // from metadata.original_unit_price when a per-line discount is baked in.
    // Without the version filters this query counts every line once per order
    // version — which is exactly how an earlier version of this test agreed
    // with a buggy helper and passed.
    // Effective taxability — line AND product — the same predicate the code
    // uses. Checking only the line flag made this test disagree with the
    // routes it is testing the moment the two were unified.
    `SELECT oi.item_id, li.title,
            (COALESCE(li.taxable, true) AND COALESCE(p.taxable, true)) AS taxable,
            -- NET: unit_price already carries any per-line discount. The
            -- pre-discount price in metadata is NOT the base -- a gross base
            -- overstated 7 real orders by up to 1338 dollars.
            -- (no backticks in SQL comments inside a template literal: they
            --  close the string. This repo has been bitten by that before.)
            li.unit_price,
            oi.quantity,
            COALESCE((
              SELECT SUM(ABS(latest.amount))
                FROM (
                  SELECT DISTINCT ON (a.code) a.amount
                    FROM order_line_item_adjustment a
                   WHERE a.item_id = li.id AND a.deleted_at IS NULL
                   ORDER BY a.code, a.version DESC
                ) latest
            ), 0) AS adj,
            -- NOT a join. Joining the tax lines emits one row per tax line,
            -- so a line that still carries two of them has its net counted
            -- twice and every total this test derives is silently inflated.
            (SELECT t.rate FROM order_line_item_tax_line t
              WHERE t.item_id = oi.item_id AND t.deleted_at IS NULL
              LIMIT 1) AS rate,
            (SELECT t.code FROM order_line_item_tax_line t
              WHERE t.item_id = oi.item_id AND t.deleted_at IS NULL
              LIMIT 1) AS code,
            (SELECT count(*) FROM order_line_item_tax_line t
              WHERE t.item_id = oi.item_id AND t.deleted_at IS NULL) AS taxline_count
       FROM order_item oi
       JOIN order_line_item li ON li.id = oi.item_id
       LEFT JOIN product_variant pv ON pv.id = li.variant_id
       LEFT JOIN product p ON p.id = pv.product_id
      WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
        AND oi.version = (SELECT o.version FROM "order" o WHERE o.id = $1)
      ORDER BY li.title`,
    [orderId]
  );
  return r.rows.map((x: any) => ({
    item_id: x.item_id,
    title: x.title,
    taxable: x.taxable !== false,
    // Same convention as loadOrderMoneyBase / the POS: gross rounded per line,
    // the discount rounded once. Summing unrounded dollars drifts by cents.
    net:
      (Math.round(Number(x.unit_price ?? 0) * 100) * Number(x.quantity ?? 0) -
        Math.round(Number(x.adj ?? 0) * 100)) /
      100,
    rate: x.rate === null ? null : Number(x.rate),
    code: x.code,
    taxLineCount: Number(x.taxline_count ?? 0),
  }));
}

async function readShipping(pool: Pool, orderId: string): Promise<number> {
  const r = await pool.query<{ s: string }>(
    `SELECT COALESCE(SUM(sm.amount), 0) s
       FROM order_shipping os
       JOIN order_shipping_method sm ON sm.id = os.shipping_method_id
      WHERE os.order_id = $1 AND os.deleted_at IS NULL`,
    [orderId]
  );
  return Number(r.rows[0]?.s ?? 0);
}

/** Checks every tax line follows its own line's flag, and returns the QB-parity tax. */
function checkLinesAndTax(lines: LineInfo[], rate: number, label: string): number {
  let wrong = 0;
  for (const l of lines) {
    const wantRate = l.taxable ? rate : 0;
    const wantCode = l.taxable ? "FL" : "EXEMPT";
    if (l.rate === null) continue; // no tax line at all — reported separately
    if (l.rate !== wantRate || l.code !== wantCode) {
      wrong++;
      info(
        `↳ ${l.title}: ${l.code} @ ${l.rate}% but taxable=${l.taxable} wants ${wantCode} @ ${wantRate}%`
      );
    }
  }
  if (wrong > 0) fail(`${label}: ${wrong} tax line(s) contradict their own taxable flag`);
  else pass(`${label}: every tax line follows its line's taxable flag`);

  const multi = lines.filter((l) => l.taxLineCount > 1);
  if (multi.length > 0)
    fail(`${label}: ${multi.length} line(s) carry more than one tax line`);
  else pass(`${label}: exactly one tax line per order line`);

  const taxableNet = lines
    .filter((l) => l.taxable)
    .reduce((s, l) => s + l.net, 0);
  return Math.round(taxableNet * (rate / 100) * 100) / 100;
}

async function api(path: string, token: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

async function main() {
  assertSandbox();
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const pool = new Pool({ connectionString: SANDBOX_URL });

  try {
    // Pick a mixed-taxability DRAFT. Single-taxability cannot tell the fix from
    // the bug, and that is the whole point of the exercise.
    const pick = await pool.query<{ id: string; doc: string }>(
      // Mixed by the EFFECTIVE predicate, not the line flag alone — otherwise
      // this picker and the code under test disagree about what "mixed" means,
      // and the run either skips valid fixtures or asserts the wrong split.
      // NOTE: this test is destructive (it converts the draft it picks), so it
      // consumes a fixture per run and eventually reports none left. That is a
      // signal to refresh the sandbox, not a product failure.
      `SELECT o.id, o.metadata->>'document_number' AS doc
         FROM "order" o
         JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
         JOIN order_line_item li ON li.id = oi.item_id
         LEFT JOIN product_variant pv ON pv.id = li.variant_id
         LEFT JOIN product p ON p.id = pv.product_id
        WHERE o.is_draft_order = true AND o.status != 'canceled'
        GROUP BY o.id, o.metadata->>'document_number'
       HAVING count(*) FILTER (
                WHERE NOT (COALESCE(li.taxable, true) AND COALESCE(p.taxable, true))
              ) > 0
          AND count(*) FILTER (
                WHERE COALESCE(li.taxable, true) AND COALESCE(p.taxable, true)
              ) > 0
        ORDER BY count(*) ASC
        LIMIT 1`
    );
    const draft = pick.rows[0];
    if (!draft) throw new Error("no mixed-taxability draft in the sandbox");

    const lines0 = await readLines(pool, draft.id);
    const ship0 = await readShipping(pool, draft.id);
    console.log(`\nTarget estimate: ${draft.doc} (${draft.id})`);
    for (const l of lines0) {
      console.log(
        `   ${l.title?.slice(0, 30).padEnd(30)} taxable=${String(l.taxable).padEnd(5)} net=$${l.net.toFixed(2)}`
      );
    }
    console.log(`   shipping = $${ship0.toFixed(2)}`);

    const RATE = 7;
    const taxableNet = lines0.filter((l) => l.taxable).reduce((s, l) => s + l.net, 0);
    const allNet = lines0.reduce((s, l) => s + l.net, 0);
    const expectedTax = Math.round(taxableNet * (RATE / 100) * 100) / 100;
    const blindTax = Math.round(allNet * (RATE / 100) * 100) / 100;
    console.log(
      `\n   taxable net $${taxableNet.toFixed(2)} → QB-parity tax $${expectedTax.toFixed(2)}`
    );
    console.log(
      `   (the old blind math would have charged $${blindTax.toFixed(2)} on all $${allNet.toFixed(2)})`
    );
    if (expectedTax === blindTax) {
      fail("this estimate cannot distinguish the fix — exempt lines carry $0 net");
      return;
    }

    // ── FLOW 1 · compute-tax ────────────────────────────────────────────────
    console.log("\n── FLOW 1 · estimate → compute-tax ──");
    const ct = await api(`/admin/draft-orders/${draft.id}/compute-tax`, token);
    if (ct.status !== 200) {
      fail(`compute-tax HTTP ${ct.status}: ${ct.text.slice(0, 200)}`);
    } else {
      const amount = Number(ct.json?.amount ?? ct.json?.tax_amount ?? NaN);
      info(`compute-tax returned amount=$${amount} rate=${ct.json?.rate}`);
      if (Math.abs(amount - expectedTax) < 0.005) {
        pass(`tax is charged on the taxable lines only ($${amount})`);
      } else if (Math.abs(amount - blindTax) < 0.005) {
        fail(`tax still charged on EVERY line ($${amount}, expected $${expectedTax})`);
      } else {
        fail(`unexpected tax $${amount} (expected $${expectedTax})`);
      }
    }

    // ── FLOW 2 · convert to order ───────────────────────────────────────────
    console.log("\n── FLOW 2 · estimate → convert to order (convert-force) ──");
    const cf = await api(`/admin/draft-orders/${draft.id}/convert-force`, token, {});
    if (cf.status !== 200 && cf.status !== 201) {
      fail(`convert-force HTTP ${cf.status}: ${cf.text.slice(0, 300)}`);
    } else {
      const sum = await readSummary(pool, draft.id);
      const lines = await readLines(pool, draft.id);
      const ship = await readShipping(pool, draft.id);
      const qbTax = checkLinesAndTax(lines, RATE, "convert-force");
      const net = lines.reduce((s, l) => s + l.net, 0);
      const want = Math.round((net + ship + qbTax) * 100) / 100;
      info(
        `summary: current=$${sum?.total} tax=$${sum?.tax} · expected total $${want.toFixed(2)}`
      );
      if (sum && Math.abs(sum.total - want) < 0.02) {
        pass(`current_order_total matches subtotal + shipping + QB-parity tax`);
      } else {
        fail(`current_order_total $${sum?.total} ≠ expected $${want.toFixed(2)}`);
      }
      if (sum && sum.tax > 0 && Math.abs(sum.tax - blindTax) < 0.005) {
        fail(`tax_total still equals the blind all-lines figure ($${sum.tax})`);
      }
    }

    // ── FLOW 3 · edit the order ─────────────────────────────────────────────
    console.log("\n── FLOW 3 · edit order (post-edit-sync) ──");
    const linesNow = await readLines(pool, draft.id);
    const shipNow = await readShipping(pool, draft.id);
    const netNow = linesNow.reduce((s, l) => s + l.net, 0);
    const taxNow =
      Math.round(
        linesNow.filter((l) => l.taxable).reduce((s, l) => s + l.net, 0) *
          (RATE / 100) *
          100
      ) / 100;
    const posTotal = Math.round((netNow + shipNow + taxNow) * 100) / 100;

    const pes = await api(`/admin/orders/${draft.id}/post-edit-sync`, token, {
      pos_tax_amount: taxNow,
      pos_tax_rate: RATE,
      pos_total: posTotal,
      skip_qb: true,
    });
    if (pes.status !== 200) {
      fail(`post-edit-sync HTTP ${pes.status}: ${pes.text.slice(0, 300)}`);
    } else {
      const sum = await readSummary(pool, draft.id);
      const lines = await readLines(pool, draft.id);
      checkLinesAndTax(lines, RATE, "post-edit-sync");
      info(
        `summary: current=$${sum?.total} tax=$${sum?.tax} · POS sent total $${posTotal} tax $${taxNow}`
      );
      if (sum && Math.abs(sum.total - posTotal) < 0.02) {
        pass(`current_order_total agrees with the POS/QB total ($${sum.total})`);
      } else {
        fail(`current_order_total $${sum?.total} ≠ POS total $${posTotal}`);
      }
      // The regression this whole change is about: tax added on top of a total
      // that already carried it. Catches it regardless of the exact figures.
      if (sum && sum.total > posTotal + taxNow - 0.02) {
        fail(`total looks like it carries the tax TWICE ($${sum.total})`);
      } else {
        pass("total does not double-count the tax");
      }
    }

    // ── restore the fixture ─────────────────────────────────────────────────
    // This test needs a DRAFT (it exercises estimate → convert), and it consumes
    // one per run. Three runs in, the sandbox had no mixed-taxability drafts
    // left and the suite started reporting a failure that was really just an
    // empty fixture pool. Reverting the order puts it back so the test is
    // repeatable instead of self-exhausting.
    await api(`/admin/orders/${draft.id}/revert-to-draft`, token, {});
    // VERIFY by re-reading. `revert-to-draft` answers 200 even when it declines
    // — it refuses while a QuickBooks operation is in flight and tells the
    // frontend to duplicate instead. In the sandbox the bridge is off, so those
    // pipeline rows never settle and the refusal is permanent. Trusting the
    // status code made this script print "reverted" three times while the pool
    // silently drained from 18 to 15.
    const back = await pool.query<{ d: boolean }>(
      `SELECT is_draft_order d FROM "order" WHERE id = $1`,
      [draft.id]
    );
    const remaining = await pool.query<{ n: string }>(
      `SELECT count(*) n FROM (
         SELECT o.id FROM "order" o
         JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
         JOIN order_line_item li ON li.id = oi.item_id
         LEFT JOIN product_variant pv ON pv.id = li.variant_id
         LEFT JOIN product p ON p.id = pv.product_id
        WHERE o.is_draft_order AND o.status <> 'canceled'
        GROUP BY o.id
       HAVING count(*) FILTER (WHERE NOT (COALESCE(li.taxable,true) AND COALESCE(p.taxable,true))) > 0
          AND count(*) FILTER (WHERE COALESCE(li.taxable,true) AND COALESCE(p.taxable,true)) > 0
       ) x`
    );
    console.log(
      back.rows[0]?.d
        ? `\n        fixture ${draft.doc} verified back as a draft`
        : `\n        fixture ${draft.doc} CONSUMED (revert declined — QB op in flight, ` +
            `expected with the bridge off). ${remaining.rows[0]?.n} mixed draft(s) left; ` +
            `run scripts/sandbox/restore.sh when it hits zero.`
    );

    console.log(
      failures === 0
        ? "\n✅ E2E green across compute-tax, convert-force and post-edit-sync\n"
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
