/**
 * Proves the strict no-op looks at `raw_rate`, not just `rate`.
 *
 * Medusa reads its money and BigNumber fields from the `raw_*` JSONB rather than
 * the numeric column, so a tax line with `rate = 7` and a stale
 * `raw_rate.value = 0` computes ZERO tax while looking correct to any
 * rate-only comparison. The first version of the no-op compared rate and code
 * only, so it would classify that row as "unchanged" and leave the bad value in
 * place permanently.
 *
 * Plant the bad raw_rate, run the rewrite, and the row must come back repaired.
 *
 * Run: cd backend && ./node_modules/.bin/tsx src/scripts/debug/probe-rawrate-noop.ts <orderId>
 */
import { Pool } from "pg";

import { replaceOrderTaxLines } from "../../lib/order-money/order-tax-lines";

const SB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

async function rows(p: Pool, orderId: string) {
  const r = await p.query(
    `SELECT t.id, t.code, t.rate, t.raw_rate->>'value' AS raw
       FROM order_line_item_tax_line t
      WHERE t.item_id IN (SELECT item_id FROM order_item WHERE order_id = $1)
        AND t.deleted_at IS NULL
      ORDER BY t.code`,
    [orderId]
  );
  return r.rows as Array<{ id: string; code: string; rate: string; raw: string }>;
}

async function main() {
  const orderId = process.argv[2];
  if (!orderId) throw new Error("usage: probe-rawrate-noop.ts <orderId>");
  const u = new URL(SB);
  if (!["localhost", "127.0.0.1"].includes(u.hostname) || u.port !== "5499") {
    throw new Error("sandbox only");
  }
  const p = new Pool({ connectionString: SB });
  let bad = 0;

  const before = await rows(p, orderId);
  console.log("  antes: ", JSON.stringify(before.map((x) => `${x.code}@${x.rate} raw=${x.raw}`)));
  const planted = before.some((x) => Number(x.rate) !== Number(x.raw));
  if (!planted) {
    console.log("  (no hay raw_rate desalineado plantado — nada que probar)");
    await p.end();
    return;
  }

  await replaceOrderTaxLines(p, orderId, 7);

  const after = await rows(p, orderId);
  console.log("  despues:", JSON.stringify(after.map((x) => `${x.code}@${x.rate} raw=${x.raw}`)));

  const stillBad = after.filter((x) => Number(x.rate) !== Number(x.raw));
  if (stillBad.length > 0) {
    bad++;
    console.log(`  FALLA: ${stillBad.length} fila(s) siguen con raw_rate desalineado`);
  } else {
    console.log("  OK: el rewrite reparo el raw_rate (el no-op NO se lo salteo)");
  }

  await p.end();
  if (bad > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
