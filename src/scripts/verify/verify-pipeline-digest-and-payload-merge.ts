/**
 * Regression cover for the two "silent failure" fixes:
 *
 *   1. qb_order_pipeline digest re-surface — a row that exhausts its retry
 *      ladder goes dormant (`failed`, next_retry_at NULL, updated_at frozen)
 *      and used to fall out of the digest's 24h window forever. CM-1087 sat
 *      broken and unreported for 14 days that way.
 *
 *   2. writePipelineRow payload MERGE — patch-meta enqueues a credit_memo_mod
 *      carrying only sales-rep/tax fields, and the credit_memo_mod row is
 *      reused for the CM's whole life. REPLACE semantics meant that a tax tweak
 *      landing on a not-yet-dispatched edit silently dropped that edit's
 *      `items`: the line changes lived in Medusa and never reached QB.
 *
 * Both are pure SQL semantics, so they are exercised as SQL against the real
 * schema inside a transaction that is ALWAYS rolled back — nothing persists.
 *
 * Run: ./node_modules/.bin/tsx src/scripts/verify/verify-pipeline-digest-and-payload-merge.ts
 */

import { readFileSync } from "fs";
import { join } from "path";
import { Client } from "pg";

function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = readFileSync(join(process.cwd(), ".env"), "utf8");
  const line = envFile.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found in env or .env");
  return line.slice("DATABASE_URL=".length).trim();
}

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (ok) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name}\n       expected: ${expected}\n       actual:   ${actual}`);
  }
}

// The digest's dormant-row predicate, verbatim from qb-pipeline-error-digest.ts.
const DIGEST_PREDICATE = `
  (updated_at >= now() - interval '24 hours'
   OR (digest_notified_at IS NULL
       OR updated_at > digest_notified_at
       OR digest_notified_at < now() - interval '7 days'))`;

// The merge expression from row-mutations.ts payloadAssignment(mergePayload=true).
const MERGE_EXPR = `COALESCE(existing, '{}'::jsonb) || COALESCE(incoming, '{}'::jsonb)`;
// ...and the default REPLACE it contrasts with.
const REPLACE_EXPR = `COALESCE(incoming, existing)`;

async function main(): Promise<void> {
  const client = new Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();

  try {
    await client.query("BEGIN");

    console.log("\n1. Digest re-surface predicate (dormant rows must come back)");
    // Column may not exist yet on an un-migrated DB — add it inside the tx.
    await client.query(
      `ALTER TABLE qb_order_pipeline ADD COLUMN IF NOT EXISTS digest_notified_at timestamptz NULL`
    );
    const cases = [
      { name: "never notified → reported", upd: "14 days", note: null, want: true },
      { name: "notified 13d ago, still broken → re-surfaces (7d safety net)", upd: "14 days", note: "13 days", want: true },
      { name: "notified 2d ago, nothing moved → stays quiet (no daily spam)", upd: "14 days", note: "2 days", want: false },
      { name: "retried since last notice → re-surfaces", upd: "1 hour", note: "2 days", want: true },
      { name: "broke inside the 24h window → reported", upd: "3 hours", note: "1 hour", want: true },
    ];
    for (const c of cases) {
      const { rows } = await client.query(
        `SELECT ${DIGEST_PREDICATE.replace(/updated_at/g, "$1::timestamptz").replace(
          /digest_notified_at/g,
          "$2::timestamptz"
        )} AS hit`,
        [
          `${new Date(Date.now() - parseInterval(c.upd)).toISOString()}`,
          c.note ? `${new Date(Date.now() - parseInterval(c.note)).toISOString()}` : null,
        ]
      );
      check(c.name, rows[0].hit, c.want);
    }

    console.log("\n2. Payload MERGE vs REPLACE (patch-meta must not drop items)");
    const existing = JSON.stringify({
      items: [{ sku: "ABC", quantity: 2 }],
      customerId: "80002180-1754404456",
    });
    const incoming = JSON.stringify({ salesRepRef: "AAA", taxExempt: true });

    const { rows: merged } = await client.query(
      `SELECT (${MERGE_EXPR}) AS out FROM (SELECT $1::jsonb AS existing, $2::jsonb AS incoming) s`,
      [existing, incoming]
    );
    const { rows: replaced } = await client.query(
      `SELECT (${REPLACE_EXPR}) AS out FROM (SELECT $1::jsonb AS existing, $2::jsonb AS incoming) s`,
      [existing, incoming]
    );

    check(
      "REPLACE loses items (the bug being fixed)",
      merged[0].out.items !== undefined && replaced[0].out.items === undefined,
      true
    );
    check("MERGE keeps items", JSON.stringify(merged[0].out.items), JSON.stringify([{ sku: "ABC", quantity: 2 }]));
    check("MERGE keeps unrelated existing keys", merged[0].out.customerId, "80002180-1754404456");
    check("MERGE applies the incoming keys", merged[0].out.salesRepRef, "AAA");

    const { rows: winner } = await client.query(
      `SELECT ('{"taxExempt":false}'::jsonb || '{"taxExempt":true}'::jsonb) ->> 'taxExempt' AS v`
    );
    check("incoming key wins on conflict", winner[0].v, "true");

    const { rows: nullIncoming } = await client.query(
      `SELECT (COALESCE('{"items":[1]}'::jsonb,'{}'::jsonb) || COALESCE(NULL::jsonb,'{}'::jsonb)) AS out`
    );
    check("a NULL incoming payload erases nothing", JSON.stringify(nullIncoming[0].out), '{"items":[1]}');
  } finally {
    // ALWAYS roll back — this script must never leave a trace on any database.
    await client.query("ROLLBACK");
    await client.end();
  }

  console.log(
    failures === 0
      ? "\n✅ digest re-surface + payload merge verified\n"
      : `\n❌ ${failures} check(s) failed\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

function parseInterval(spec: string): number {
  const [n, unit] = spec.split(" ");
  const ms: Record<string, number> = {
    hour: 3600_000,
    hours: 3600_000,
    day: 86_400_000,
    days: 86_400_000,
  };
  return Number(n) * ms[unit];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
