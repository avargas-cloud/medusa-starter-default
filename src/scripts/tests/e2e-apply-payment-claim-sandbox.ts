/**
 * e2e-apply-payment-claim-sandbox
 *
 * End-to-end proof, against real Postgres, that `claimApplyPaymentRow` actually
 * claims — and actually refuses.
 *
 * WHY THIS EXISTS
 * The unit spec (src/__tests__/qb-apply-dispatch/single-dispatch.unit.spec.ts)
 * passes a FAKE pool, so its SQL never executes. It pins the DECISION given what
 * the pool returns; it cannot see whether the statement matches a row. Its own
 * header says the statement is "proven by the sandbox E2E against real Postgres"
 * — this is that E2E, which did not exist when the fix was written.
 *
 * The gap is not theoretical here. `qb_order_pipeline.id` is **uuid**, and the
 * claim compares it against a JavaScript string (`WHERE id = $1`). This project
 * has already shipped a gate silently disabled by exactly that kind of cast, and
 * the failure mode of THIS one is severe and quiet: if the UPDATE never matches,
 * every claim returns `held_by_other`, every apply_payment declines to dispatch,
 * and the only trace is a `logger.info` reading "already claimed by another
 * dispatcher". A money pipeline switched off with no error anywhere.
 *
 * WHAT MAKES THE ASSERTIONS REAL
 * Every claim assertion reads the row back from Postgres. Trusting the returned
 * outcome alone would pass against an UPDATE that matches nothing — the function
 * would report "claimed" and the row would sit untouched. The concurrency case
 * uses TWO separate connections, because one client serialises its own queries
 * and would prove nothing about the SERVER-vs-WORKER race this fix exists for.
 *
 * SAFETY
 * Refuses to run unless DATABASE_URL points at sandbox Postgres (5499). Every
 * fixture is prefixed `e2eclaim_`, removed in a finally block, and the script
 * asserts the cleanup actually happened.
 *
 * Run (sandbox stack up):
 *   env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-apply-payment-claim-sandbox.ts
 */
import { Client } from "pg";

import { claimApplyPaymentRow } from "../../lib/quickbooks/handlers/handle-pos-payment-applied";

const PREFIX = "e2eclaim_";
const ORDER_ID = `${PREFIX}order`;

let failures = 0;
const assert = (ok: boolean, label: string, detail = ""): void => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/** Insert one apply_payment row and return its id. */
async function seedRow(
  client: Client,
  referenceId: string,
  status: string
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO qb_order_pipeline (order_id, reference_id, reference_type, step, status)
     VALUES ($1, $2, 'payment_application', 'apply_payment', $3)
     RETURNING id`,
    [ORDER_ID, referenceId, status]
  );
  return String(rows[0].id);
}

async function statusOf(client: Client, rowId: string): Promise<string> {
  const { rows } = await client.query(
    `SELECT status FROM qb_order_pipeline WHERE id = $1`,
    [rowId]
  );
  return String(rows[0]?.status ?? "<gone>");
}

async function cleanup(client: Client): Promise<void> {
  await client.query(`DELETE FROM qb_order_pipeline WHERE order_id = $1`, [
    ORDER_ID,
  ]);
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ??
    "postgresql://postgres:sandbox@localhost:5499/medusa";
  if (!/:5499\b/.test(connectionString)) {
    throw new Error(
      "Refusing to run: DATABASE_URL is not sandbox Postgres (expected port 5499)"
    );
  }

  const client = new Client({ connectionString });
  await client.connect();

  // Second connection — the WORKER. One client serialises its own queries, so a
  // single connection cannot exhibit the cross-process race this fix addresses.
  const rival = new Client({ connectionString });
  await rival.connect();

  try {
    await cleanup(client);

    // ── 1. The control positive ───────────────────────────────────────────────
    // Claiming must MOVE the row. Asserting only on the returned outcome would
    // pass against an UPDATE that matches nothing.
    for (const startStatus of ["waiting", "pending", "failed"]) {
      const ref = `${PREFIX}papp_claimable_${startStatus}`;
      const rowId = await seedRow(client, ref, startStatus);
      const claim = await claimApplyPaymentRow(client, ORDER_ID, ref, null);
      const after = await statusOf(client, rowId);
      assert(
        claim.outcome === "claimed",
        `'${startStatus}' row is claimable`,
        `outcome=${claim.outcome}`
      );
      assert(
        after === "processing",
        `'${startStatus}' row actually moved to processing in Postgres`,
        `db status=${after}`
      );
    }

    // ── 2. States a claim must refuse ─────────────────────────────────────────
    for (const startStatus of ["processing", "submitted", "confirmed"]) {
      const ref = `${PREFIX}papp_locked_${startStatus}`;
      const rowId = await seedRow(client, ref, startStatus);
      const claim = await claimApplyPaymentRow(client, ORDER_ID, ref, null);
      const after = await statusOf(client, rowId);
      assert(
        claim.outcome === "held_by_other",
        `'${startStatus}' row is refused`,
        `outcome=${claim.outcome}`
      );
      assert(
        after === startStatus,
        `'${startStatus}' row was left untouched`,
        `db status=${after}`
      );
    }

    // ── 3. No row at all ──────────────────────────────────────────────────────
    const claimNoRow = await claimApplyPaymentRow(
      client,
      ORDER_ID,
      `${PREFIX}papp_absent`,
      null
    );
    assert(
      claimNoRow.outcome === "no_row",
      "a pair with no row reports no_row",
      `outcome=${claimNoRow.outcome}`
    );

    // ── 4. The consolidator's own row ─────────────────────────────────────────
    // It already claimed with FOR UPDATE SKIP LOCKED before calling. Re-claiming
    // would see its own 'processing' and refuse to dispatch at all.
    const refPre = `${PREFIX}papp_preclaimed`;
    const rowPre = await seedRow(client, refPre, "processing");
    const claimPre = await claimApplyPaymentRow(
      client,
      ORDER_ID,
      refPre,
      rowPre
    );
    assert(
      claimPre.outcome === "claimed",
      "the consolidator passes through on the row it already owns",
      `outcome=${claimPre.outcome}`
    );
    assert(
      (await statusOf(client, rowPre)) === "processing",
      "…without rewriting that row"
    );

    // A DIFFERENT row's id must not act as a skeleton key.
    const refOther = `${PREFIX}papp_other`;
    await seedRow(client, refOther, "processing");
    const claimWrongPre = await claimApplyPaymentRow(
      client,
      ORDER_ID,
      refOther,
      rowPre
    );
    assert(
      claimWrongPre.outcome === "held_by_other",
      "a foreign pre-claimed id does not unlock someone else's row",
      `outcome=${claimWrongPre.outcome}`
    );

    // ── 5. The actual race: two connections, one row ──────────────────────────
    const refRace = `${PREFIX}papp_race`;
    const rowRace = await seedRow(client, refRace, "waiting");
    const [a, b] = await Promise.all([
      claimApplyPaymentRow(client, ORDER_ID, refRace, null),
      claimApplyPaymentRow(rival, ORDER_ID, refRace, null),
    ]);
    const winners = [a, b].filter((c) => c.outcome === "claimed").length;
    const losers = [a, b].filter((c) => c.outcome === "held_by_other").length;
    assert(
      winners === 1 && losers === 1,
      "two dispatchers race for one row: exactly one wins",
      `claimed=${winners} held_by_other=${losers}`
    );
    assert(
      (await statusOf(client, rowRace)) === "processing",
      "the contested row ends up processing"
    );

    // ── 6. A skipped sibling must not shadow the live row ─────────────────────
    // `uq_qb_pipeline_apply_payment_papp` is unique on reference_id but EXCLUDES
    // `status <> 'skipped'`, so exactly one shape of duplicate pair is legal: a
    // skipped row plus a live one. That is the shape the five legacy pairs in
    // production have. The claim reads `ORDER BY created_at DESC LIMIT 1`, so if
    // it looked at the skipped sibling it would report held_by_other and the
    // live row would never dispatch.
    const refDup = `${PREFIX}papp_dup`;
    await seedRow(client, refDup, "skipped");
    const rowDupNew = await seedRow(client, refDup, "waiting");
    const claimDup = await claimApplyPaymentRow(client, ORDER_ID, refDup, null);
    assert(
      claimDup.outcome === "claimed",
      "a skipped sibling does not shadow the live row",
      `outcome=${claimDup.outcome}`
    );
    assert(
      (await statusOf(client, rowDupNew)) === "processing",
      "…and it is the live row that moved"
    );
  } finally {
    await cleanup(client);
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n FROM qb_order_pipeline WHERE order_id = $1`,
      [ORDER_ID]
    );
    assert(rows[0].n === 0, "fixtures cleaned up", `${rows[0].n} left`);
    await client.end();
    await rival.end();
  }

  console.log(
    failures === 0
      ? "\n🎉 apply_payment claim verified against real Postgres"
      : `\n💥 ${failures} assertion(s) failed`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
