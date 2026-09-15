import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDbPool } from "../../api/utils/db-pool";
import { OpeningSandboxApi } from "../../lib/banking/opening-sandbox-api";
import { requireBankingSandbox } from "../../lib/banking/security";
import type { StatementContext } from "../../lib/banking/statement-types";

/**
 * statement-reopen-chain-20260915 — reopening July 7223 while August is closed
 * reopens BOTH (newest first) and the Month Close that covers July, in one
 * transaction, through `GET/POST /admin/banking/statements/:id/reopen-chain`.
 * Then re-closing in order is enforced (August waits for July) and the fixture
 * is put back the way it was, so a second run passes too.
 *
 *   cd backend && env DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/<clone> \
 *     BANKING_SANDBOX_API_BASE=http://localhost:9095 ECOPOWERTECH_ENV=sandbox \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-bank-reopen-chain-sandbox.ts
 *
 * Fixture it OWNS: `accounting_period_close` row `apc_e2e_reopen_chain` (July 2026,
 * summary `{}`) and, briefly, `accounting_period_adjustment` `apa_e2e_reopen_chain`.
 * Both are removed at the end and swept at the start.
 */
type Value = Record<string, unknown>;
type Chain = {
  target: { id: string; from: string; to: string; revision: number };
  statements: Array<{ id: string; from: string; to: string; revision: number }>;
  months: Array<{ month: string; close_id: string; revision: number; input_hash: string }>;
  blockers: Array<{ month: string; code: string }>;
  chain_hash: string;
};
const MASK = "7223";
const APC = "apc_e2e_reopen_chain";
const APA = "apa_e2e_reopen_chain";
const base = "/admin/banking/statements";

async function main(): Promise<void> {
  requireBankingSandbox();
  const pool = getDbPool();
  const client = await pool.connect();
  const test = new OpeningSandboxApi();
  let restored = true;
  let chainIds: string[] = [];
  const reclose = async (id: string, label: string) => {
    const ctx = (await test.api(`${base}/${id}`)) as StatementContext;
    if (ctx.statement.status === "closed") return;
    const preview = (await test.api(`${base}/${id}/preview`, { expected_revision: ctx.statement.revision })) as StatementContext & { preview_hash: string };
    assert.deepEqual(preview.blockers, [], `${label} has no blockers to re-close`);
    const closed = (await test.api(`${base}/${id}/close`, { expected_revision: ctx.statement.revision, preview_hash: preview.preview_hash })) as StatementContext;
    test.check(closed.statement.status === "closed", `${label} re-closed`);
  };
  try {
    await test.login();
    await client.query("DELETE FROM accounting_period_adjustment WHERE id=$1", [APA]);
    await client.query("DELETE FROM accounting_period_close WHERE id=$1", [APC]);

    const rows = (
      await client.query<{ id: string; from_day: string; revision: number; status: string }>(
        `SELECT st.id,st.from_day::text AS from_day,st.revision,st.status FROM bank_statement st
         JOIN bank_account a ON a.id=st.bank_account_id
         WHERE a.mask=$1 AND st.deleted_at IS NULL AND st.from_day IN ('2026-06-01','2026-07-01','2026-08-01')
         ORDER BY st.from_day`,
        [MASK]
      )
    ).rows;
    const [jun, jul, aug] = rows;
    assert(jun && jul && aug && rows.every((r) => r.status === "closed"), "fixture: June/July/August 7223 closed");
    const othersClosed = async () =>
      Number(
        (
          await client.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM bank_statement st JOIN bank_account a ON a.id=st.bank_account_id
             WHERE a.mask<>$1 AND st.status='closed' AND st.deleted_at IS NULL`,
            [MASK]
          )
        ).rows[0]!.n
      );
    const othersBefore = await othersClosed();
    const eventsBefore = Number(
      (await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM bank_review_event WHERE action='statement_reopened'")).rows[0]!.n
    );

    // ── Month Close covering July (summary {} ⇒ delta 0) ──────────────────────
    await client.query(
      `INSERT INTO accounting_period_close (id, period_start, period_end, revision, status, summary, open_documents, readiness, closed_by_user_id)
       VALUES ($1, '2026-07-01', '2026-08-01', (SELECT COALESCE(MAX(revision),0)+1 FROM accounting_period_close WHERE period_start='2026-07-01'), 'closed', '{}', '[]', '{}', 'e2e-reopen-chain')`,
      [APC]
    );

    // ── Baseline: the single reopen still refuses July (guard untouched) ──────
    await test.api(`${base}/${jul.id}/reopen`, { expected_revision: jul.revision, reason: "e2e baseline guard" }, 409);

    // ── Preview ───────────────────────────────────────────────────────────────
    let chain = (await test.api(`${base}/${jul.id}/reopen-chain`)).chain as Chain;
    test.check(chain.statements.map((s) => s.id).join(",") === `${aug.id},${jul.id}`, "chain lists August first, then July (newest → target)");
    test.check(chain.statements[0]!.revision === aug.revision && chain.statements[1]!.revision === jul.revision, "chain carries the current revisions");
    test.check(chain.months.length === 1 && chain.months[0]!.month === "2026-07" && chain.months[0]!.close_id === APC, "the July Month Close is part of the chain");
    test.check(/^[a-f0-9]{64}$/.test(chain.months[0]!.input_hash) && /^[a-f0-9]{64}$/.test(chain.chain_hash), "month preview hash and chain hash are sha256");
    test.check(chain.blockers.length === 0, "no blockers");
    const augChain = (await test.api(`${base}/${aug.id}/reopen-chain`)).chain as Chain;
    test.check(augChain.statements.length === 1 && augChain.months.length === 0, "August (most recent) is a chain of one with no month");

    // ── A posted prior-period adjustment blocks the month, hence the chain ────
    await client.query(
      `INSERT INTO accounting_period_adjustment (id, source_close_id, target_period_start, target_period_end, status, delta, source_input_hash, reason, posted_by_user_id)
       VALUES ($1,$2,'2026-08-01','2026-09-01','posted','{}','x','e2e','e2e-reopen-chain')`,
      [APA, APC]
    );
    const blocked = (await test.api(`${base}/${jul.id}/reopen-chain`)).chain as Chain;
    test.check(blocked.blockers.length === 1 && blocked.blockers[0]!.code === "posted_adjustment_must_be_reversed_first" && blocked.months.length === 0, "posted adjustment surfaces as a blocker");
    const blockedPost = await test.api(`${base}/${jul.id}/reopen-chain`, { expected_revision: jul.revision, reason: "e2e blocked by adjustment", chain_hash: blocked.chain_hash }, 409);
    test.check(blockedPost.code === "BANKING_MONTH_REOPEN_BLOCKED", "POST refuses while the month is blocked");
    await client.query("DELETE FROM accounting_period_adjustment WHERE id=$1", [APA]);

    // ── Stale hash / stale revision: nothing moves ────────────────────────────
    const stale = await test.api(`${base}/${jul.id}/reopen-chain`, { expected_revision: jul.revision, reason: "e2e stale hash", chain_hash: "0".repeat(64) }, 409);
    test.check(stale.code === "BANKING_STATEMENT_CHAIN_STALE", "wrong chain_hash → BANKING_STATEMENT_CHAIN_STALE");
    const staleRev = await test.api(`${base}/${jul.id}/reopen-chain`, { expected_revision: jul.revision + 1, reason: "e2e stale revision", chain_hash: chain.chain_hash }, 409);
    test.check(staleRev.code === "BANKING_STATEMENT_STALE", "wrong revision → BANKING_STATEMENT_STALE");
    const still = (await client.query<{ status: string }>("SELECT status FROM bank_statement WHERE id = ANY($1)", [[jul.id, aug.id]])).rows;
    test.check(still.every((r) => r.status === "closed"), "both statements still closed after the refused attempts");

    // ── Apply ─────────────────────────────────────────────────────────────────
    chain = (await test.api(`${base}/${jul.id}/reopen-chain`)).chain as Chain;
    const key = randomUUID();
    // Unique per run: the event assertion below must not count a previous run's events.
    const reason = `e2e chain ${randomUUID().slice(0, 8)}: material July amount error found in August`;
    restored = false;
    chainIds = [jul.id, aug.id];
    const applied = (await test.api(`${base}/${jul.id}/reopen-chain`, { expected_revision: jul.revision, reason, chain_hash: chain.chain_hash }, 200, key)) as StatementContext & { chain: Value };
    test.check(applied.statement.status === "draft" && applied.statement.revision === jul.revision + 1, "July is draft, revision +1");
    const reopened = (applied.chain.reopened as Array<{ id: string }>).map((s) => s.id);
    test.check(reopened.join(",") === `${aug.id},${jul.id}`, "response names the reopened statements in order");
    test.check(JSON.stringify(applied.chain.months) === JSON.stringify([{ month: "2026-07", close_id: APC }]), "response names the reopened month");
    const after = (await client.query<{ id: string; status: string; revision: number; history: Array<{ reason: string }> }>("SELECT id,status,revision,history FROM bank_statement WHERE id = ANY($1)", [[jun.id, jul.id, aug.id]])).rows;
    const by = Object.fromEntries(after.map((r) => [r.id, r]));
    test.check(by[aug.id]!.status === "draft" && by[aug.id]!.revision === aug.revision + 1, "August is draft, revision +1");
    test.check(by[jun.id]!.status === "closed" && by[jun.id]!.revision === jun.revision, "June (before the target) is untouched");
    test.check(by[jul.id]!.history.at(-1)!.reason === reason && by[aug.id]!.history.at(-1)!.reason === reason, "each statement's history carries the reason");
    const apc = (await client.query<{ status: string; reopen_reason: string; reopened_by_user_id: string }>("SELECT status,reopen_reason,reopened_by_user_id FROM accounting_period_close WHERE id=$1", [APC])).rows[0]!;
    test.check(apc.status === "reopened" && apc.reopen_reason.startsWith(`Bank statement reopen chain ${jul.id}`) && apc.reopen_reason.endsWith(reason) && !!apc.reopened_by_user_id, "Month Close reopened with the chain-prefixed reason and the actor");
    const events = (await client.query<{ entity_id: string; details: { chain?: { root: string; position: number; of: number; months: string[] } } }>(
      "SELECT entity_id,details FROM bank_review_event WHERE action='statement_reopened' AND details->'chain'->>'root'=$1 AND details->>'reason'=$2 ORDER BY (details->'chain'->>'position')::int", [jul.id, reason]
    )).rows;
    test.check(events.length === 2 && events[0]!.entity_id === aug.id && events[0]!.details.chain!.position === 1 && events[1]!.entity_id === jul.id && events[1]!.details.chain!.of === 2 && events[1]!.details.chain!.months[0] === "2026-07", "two statement_reopened events tagged with the chain (root, position/of, months)");
    test.check((await othersClosed()) === othersBefore, "no other account's statements changed");

    // ── Idempotent replay: same key + body → same result, no new events ──────
    const replay = (await test.api(`${base}/${jul.id}/reopen-chain`, { expected_revision: jul.revision, reason, chain_hash: chain.chain_hash }, 200, key)) as StatementContext;
    test.check(replay.statement.revision === applied.statement.revision, "replay with the same idempotency key returns the receipt");
    const eventsAfter = Number((await client.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM bank_review_event WHERE action='statement_reopened'")).rows[0]!.n);
    test.check(eventsAfter === eventsBefore + 2, "exactly two reopen events were appended");

    // ── Re-close in order: August waits for July ──────────────────────────────
    const augCtx = (await test.api(`${base}/${aug.id}`)) as StatementContext;
    test.check(augCtx.blockers.includes("BANKING_STATEMENT_PREDECESSOR_REQUIRED"), "August cannot close while July is a draft (PREDECESSOR_REQUIRED)");
    await reclose(jul.id, "July");
    await reclose(aug.id, "August");
    restored = true;
    const aug2 = (await test.api(`${base}/${aug.id}/reopen-chain`)).chain as Chain;
    test.check(aug2.statements.length === 1 && aug2.months.length === 0, "after re-closing, August is again a chain of one (month stays reopened, by design)");
  } finally {
    // A failed run must not leave the fixture reopened: re-close in order, best effort.
    if (!restored)
      for (const [id, label] of [[chainIds[0], "July"], [chainIds[1], "August"]] as const)
        if (id) await reclose(id, `${label} (restore)`).catch((error) => console.error("restore failed", label, error));
    await client.query("DELETE FROM accounting_period_adjustment WHERE id=$1", [APA]);
    await client.query("DELETE FROM accounting_period_close WHERE id=$1", [APC]);
    client.release();
    await pool.end();
  }
  // eslint-disable-next-line no-console -- E2E report
  console.log(`\nreopen-chain E2E: ${test.checks} checks passed`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console -- E2E report
  console.error("FAIL", error);
  process.exit(1);
});
