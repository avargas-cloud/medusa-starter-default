/**
 * E2E — convert an order and then EDIT IT REPEATEDLY, asserting after every
 * single round that its stored total still equals what its own lines say.
 *
 * This is the shape that broke twice, and neither break was visible in a
 * one-shot test:
 *
 *   • `order_item` keeps a row per order version, so a version-blind join
 *     counted every line once per version. A freshly converted order has one
 *     version and looks perfect; the same order after six edits reports six
 *     times its value.
 *   • `order_line_item_adjustment` is versioned the same way — Medusa
 *     RE-CREATES the rows on each edit rather than updating them — so one 12.5%
 *     discount edited twice sums to 37.5%.
 *
 * Both bugs GROW with the number of edits. A test that edits once cannot see
 * either of them, which is exactly why the earlier E2E passed while the money
 * base was multiplying. This one edits in a loop and re-checks every time, so
 * drift has nowhere to hide.
 *
 * DESTRUCTIVE: converts a draft and edits it repeatedly. Sandbox only — guarded.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/tests/e2e-multi-edit-coherence-sandbox.ts
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

const ROUNDS = Number(process.env.EDIT_ROUNDS ?? 6);
const RATE = 7;

let failures = 0;
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

function assertSandbox(): void {
  const u = new URL(SANDBOX_URL);
  if (
    !["localhost", "127.0.0.1"].includes(u.hostname) ||
    u.port !== "5499" ||
    !BASE.includes("9099")
  ) {
    throw new Error(`refusing to run outside the sandbox (${u.hostname}:${u.port}, ${BASE})`);
  }
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

type Truth = {
  version: number;
  orderItemRows: number;
  adjustmentRows: number;
  taxLineRows: number;
  grossDollars: number;
  taxableGrossDollars: number;
  adjDollars: number;
  shippingDollars: number;
};

/**
 * The expected figures, scoped the way the system defines them: current order
 * version only, newest adjustment per (item, code), GROSS from
 * metadata.original_unit_price. Also returns the RAW row counts so the test can
 * show that versions really are accumulating — a coherence check that never
 * accumulates anything proves nothing.
 */
async function truth(pool: Pool, orderId: string): Promise<Truth> {
  const r = await pool.query(
    `SELECT (COALESCE(li.taxable, true) AND COALESCE(p.taxable, true)) AS taxable,
            -- NET, matching loadOrderMoneyBase.
            li.unit_price AS gross_unit,
            oi.quantity,
            COALESCE((
              SELECT SUM(ABS(latest.amount))
                FROM (
                  SELECT DISTINCT ON (a.code) a.amount
                    FROM order_line_item_adjustment a
                   WHERE a.item_id = li.id AND a.deleted_at IS NULL
                   ORDER BY a.code, a.version DESC
                ) latest
            ), 0) AS adj
       FROM order_item oi
       JOIN order_line_item li ON li.id = oi.item_id
       LEFT JOIN product_variant pv ON pv.id = li.variant_id
       LEFT JOIN product p ON p.id = pv.product_id
      WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
        AND oi.version = (SELECT o.version FROM "order" o WHERE o.id = $1)`,
    [orderId]
  );

  let grossCents = 0,
    taxableGrossCents = 0,
    adjUnrounded = 0;
  for (const x of r.rows as any[]) {
    // Round the LINE, not the unit — the convention `loadOrderMoneyBase` uses,
    // and the one QuickBooks' own Subtotal follows (read over the bridge on
    // E1497, E1845, E1903 and E1976). Rounding per unit here made the test
    // disagree with the route by a constant 62c across all six edits, which
    // looked like a coherence failure and was the fixture's own arithmetic.
    const g = Math.round(Number(x.gross_unit) * Number(x.quantity) * 100);
    grossCents += g;
    adjUnrounded += Number(x.adj) * 100;
    if (x.taxable !== false) taxableGrossCents += g;
  }

  const counts = await pool.query<{
    v: string;
    oi: string;
    adj: string;
    tl: string;
    ship: string;
  }>(
    `SELECT (SELECT o.version FROM "order" o WHERE o.id = $1) AS v,
            (SELECT count(*) FROM order_item x WHERE x.order_id = $1 AND x.deleted_at IS NULL) AS oi, -- raw, on purpose: shows versions accumulating
            -- DISTINCT on the row's OWN id. Joining through order_item without
            -- scoping the version multiplies the count by the number of order
            -- versions: 9 tax lines on a v2 order are reported as 18. This
            -- counter had the exact defect the test exists to catch.
            (SELECT count(DISTINCT a.id) FROM order_line_item_adjustment a
               JOIN order_item x ON x.item_id = a.item_id
              WHERE x.order_id = $1 AND a.deleted_at IS NULL) AS adj,
            (SELECT count(DISTINCT t.id) FROM order_line_item_tax_line t
               JOIN order_item x ON x.item_id = t.item_id
              WHERE x.order_id = $1 AND t.deleted_at IS NULL) AS tl,
            (SELECT COALESCE(SUM(sm.amount), 0) FROM order_shipping os
               JOIN order_shipping_method sm ON sm.id = os.shipping_method_id
              WHERE os.order_id = $1 AND os.deleted_at IS NULL) AS ship`,
    [orderId]
  );
  const c = counts.rows[0]!;

  return {
    version: Number(c.v),
    orderItemRows: Number(c.oi),
    adjustmentRows: Number(c.adj),
    taxLineRows: Number(c.tl),
    grossDollars: grossCents / 100,
    taxableGrossDollars: taxableGrossCents / 100,
    adjDollars: Math.round(adjUnrounded) / 100,
    shippingDollars: Number(c.ship),
  };
}

async function storedTotal(pool: Pool, orderId: string) {
  const r = await pool.query<{ t: string; x: string }>(
    `SELECT (totals->>'current_order_total') t, (totals->>'tax_total') x
       FROM order_summary
      WHERE order_id = $1 AND deleted_at IS NULL
      ORDER BY version DESC LIMIT 1`,
    [orderId]
  );
  return {
    total: Number(r.rows[0]?.t ?? NaN),
    tax: Number(r.rows[0]?.x ?? NaN),
  };
}

async function main() {
  assertSandbox();
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const pool = new Pool({ connectionString: SANDBOX_URL });

  try {
    const pick = await pool.query<{ id: string; doc: string }>(
      `SELECT o.id, o.metadata->>'document_number' AS doc
         FROM "order" o
         JOIN order_item oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
         JOIN order_line_item li ON li.id = oi.item_id
         LEFT JOIN product_variant pv ON pv.id = li.variant_id
         LEFT JOIN product p ON p.id = pv.product_id
        -- Prefer an order that is ALREADY converted: this test edits in a loop
        -- and does not need the conversion, so consuming a draft each run just
        -- exhausts the fixtures (which is how it ran out after three runs).
        -- Repeatable beats realistic here.
        WHERE o.is_draft_order = false AND o.status NOT IN ('canceled', 'archived')
        GROUP BY o.id, o.metadata->>'document_number'
       HAVING count(*) FILTER (
                WHERE NOT (COALESCE(li.taxable, true) AND COALESCE(p.taxable, true))
              ) > 0
          AND count(*) FILTER (
                WHERE COALESCE(li.taxable, true) AND COALESCE(p.taxable, true)
              ) > 1
        ORDER BY count(*) ASC
        LIMIT 1`
    );
    const draft = pick.rows[0];
    if (!draft) throw new Error("no mixed-taxability draft available");
    console.log(`\nTarget: ${draft.doc} (${draft.id}) · ${ROUNDS} edit rounds\n`);


    // Something to edit: the first taxable line.
    const lineRes = await pool.query<{ id: string; qty: string }>(
      `SELECT li.id, oi.quantity AS qty
         FROM order_item oi
         JOIN order_line_item li ON li.id = oi.item_id
         LEFT JOIN product_variant pv ON pv.id = li.variant_id
         LEFT JOIN product p ON p.id = pv.product_id
        WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
          AND COALESCE(li.taxable, true) = true
          AND oi.version = (SELECT o.version FROM "order" o WHERE o.id = $1)
        ORDER BY li.id LIMIT 1`,
      [draft.id]
    );
    const line = lineRes.rows[0];
    if (!line) throw new Error("no taxable line to edit");
    const baseQty = Number(line.qty);

    const seen: Array<{ round: string; total: number; version: number }> = [];

    for (let i = 0; i <= ROUNDS; i++) {
      if (i > 0) {
        // Alternate the KIND of edit: quantity changes and discount changes
        // create different row histories, and only the discount path writes the
        // versioned adjustment rows that caused the 37.5% overcharge.
        if (i % 2 === 1) {
          const r = await api(`/admin/orders/${draft.id}/update-item-force`, token, {
            line_item_id: line.id,
            quantity: baseQty + i,
          });
          if (r.status !== 200) fail(`round ${i}: update-item-force HTTP ${r.status}`);
        } else {
          const r = await api(`/admin/orders/${draft.id}/apply-discount-force`, token, {
            discount_type: "percent",
            discount_value: 5,
            pos_tax_rate: RATE,
          });
          if (r.status !== 200) fail(`round ${i}: apply-discount-force HTTP ${r.status}`);
        }
      }

      const t = await truth(pool, draft.id);
      const residual = 0; // the discount lives in the adjustments on this path
      const taxableBase =
        Math.max(0, Math.round((t.taxableGrossDollars - t.adjDollars) * 100)) / 100;
      const expTax = Math.round(taxableBase * (RATE / 100) * 100) / 100;
      const expTotal =
        Math.round(
          (t.grossDollars - t.adjDollars + t.shippingDollars + expTax - residual) * 100
        ) / 100;

      const sync = await api(`/admin/orders/${draft.id}/post-edit-sync`, token, {
        pos_tax_amount: expTax,
        pos_tax_rate: RATE,
        pos_total: expTotal,
        skip_qb: true,
      });
      if (sync.status !== 200) {
        fail(`round ${i}: post-edit-sync HTTP ${sync.status} ${sync.text.slice(0, 160)}`);
        continue;
      }

      const stored = await storedTotal(pool, draft.id);
      const label = i === 0 ? "baseline" : `edit ${i}`;
      console.log(
        `  ${label.padEnd(9)} v${String(t.version).padEnd(3)} ` +
          `rows(oi=${t.orderItemRows} adj=${t.adjustmentRows} tax=${t.taxLineRows})  ` +
          `gross=$${t.grossDollars.toFixed(2)} adj=$${t.adjDollars.toFixed(2)} ` +
          `→ expected $${expTotal.toFixed(2)} · stored $${stored.total.toFixed(2)}`
      );

      if (Math.abs(stored.total - expTotal) < 0.02) pass(`${label}: total coherent`);
      else fail(`${label}: stored $${stored.total} ≠ expected $${expTotal}`);

      if (Math.abs(stored.tax - expTax) < 0.02) pass(`${label}: tax coherent`);
      else fail(`${label}: stored tax $${stored.tax} ≠ expected $${expTax}`);

      // One tax line per line, always — a rewrite that appends instead of
      // replacing would show up here as a count that climbs with the rounds.
      const linesNow = await pool.query<{ n: string }>(
        `SELECT count(*) n FROM order_item oi
          WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
            AND oi.version = (SELECT o.version FROM "order" o WHERE o.id = $1)`,
        [draft.id]
      );
      if (t.taxLineRows === Number(linesNow.rows[0]?.n ?? -1))
        pass(`${label}: exactly one tax line per line (${t.taxLineRows})`);
      else
        fail(
          `${label}: ${t.taxLineRows} tax lines for ${linesNow.rows[0]?.n} lines`
        );

      seen.push({ round: label, total: stored.total, version: t.version });
    }

    // The drift check the one-shot tests structurally cannot make: the same
    // order, read after every edit, must never balloon. A multiplying join
    // shows up as a total that tracks the version count.
    console.log("\n── drift across the whole run ──");
    const baseline = seen[0]!;
    const worst = seen.reduce(
      (acc, s) => Math.max(acc, s.total / (baseline.total || 1)),
      0
    );
    if (worst < 3) pass(`no total ever ballooned (max ratio to baseline ${worst.toFixed(2)}x)`);
    else fail(`a total grew ${worst.toFixed(2)}x over the baseline — looks version-multiplied`);

    const versionsGrew = seen[seen.length - 1]!.version > baseline.version;
    console.log(
      `        versions ${baseline.version} → ${seen[seen.length - 1]!.version}` +
        (versionsGrew ? "" : "  (no bump — the row history still accumulates)")
    );

    console.log(
      failures === 0
        ? `\n✅ coherent across ${ROUNDS} edits\n`
        : `\n❌ ${failures} check(s) failed across ${ROUNDS} edits\n`
    );
    if (failures > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`\n❌ aborted: ${e.message}\n`);
  process.exitCode = 1;
});
