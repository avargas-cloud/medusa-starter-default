/** Real historical Month Close racing a zero-GL opening clear correction. */
import assert from "node:assert/strict";

import type { PoolClient } from "pg";

import { closeNote, account } from "../../scripts/tests/bank-receipts-fixtures";

import { OpeningSandboxApi, openingApiBase } from "./opening-sandbox-api";

/** Count only sessions blocked by this harness, including review-lock waiters behind a period waiter. */
export async function periodBlockedSessions(
  client: PoolClient
): Promise<number> {
  const result = await client.query<{ n: number }>(`WITH RECURSIVE
    edges AS MATERIALIZED (
      SELECT pid,pg_blocking_pids(pid) blockers FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()
    ), blocked(pid,depth) AS (
      SELECT pg_backend_pid(),0
      UNION
      SELECT e.pid,b.depth+1 FROM blocked b JOIN edges e ON b.pid=ANY(e.blockers)
      WHERE b.depth<8
    ) SELECT count(DISTINCT pid)::int n FROM blocked WHERE depth>0`);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `count(...)` sin GROUP BY siempre devuelve exactamente una fila
  return result.rows[0]!.n;
}

export async function openingPeriodChecks(
  client: PoolClient,
  test: OpeningSandboxApi,
  openingId: string,
  itemId: string,
  transactionId: string
): Promise<void> {
  const month = "2000-01";
  assert(
    !(
      await client.query(
        "SELECT 1 FROM accounting_period_close WHERE period_start='2000-01-01'"
      )
    ).rowCount,
    "No existing month history may be replaced"
  );
  const readiness = await test.api(
    `/admin/accounting/month-close?month=${month}`
  );
  test.check(
    readiness.status === "open" &&
      !(readiness.readiness as { has_blockers: boolean }).has_blockers,
    "Isolated ended month is eligible for real Month Close"
  );
  const counts = (
    await client.query(`SELECT count(*)::int n FROM inventory_level il JOIN inventory_item ii ON ii.id=il.inventory_item_id
    JOIN product_variant_inventory_item p ON p.inventory_item_id=ii.id JOIN product_variant v ON v.id=p.variant_id AND v.deleted_at IS NULL
    GROUP BY il.location_id`)
  ).rows;
  test.check(
    counts.length <= 40 && counts.every((row) => row.n <= 5000),
    "Month Close snapshots fit approved caps"
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- `itemId` viene de un item ya leído del mismo opening momentos antes en el harness (dueño de los datos), tiene que seguir presente
  const item = (await test.opening(openingId)).items.find(
    (row) => row.id === itemId
  )!;
  assert(item.clear_id);
  const unclearPath = `${openingApiBase}/items/${itemId}/unclear`;
  const unclearBody = {
    clear_id: item.clear_id,
    reason: "Owned monthly race control",
  };
  await client.query("BEGIN");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('accounting-period:2000-01',7242))"
  );
  let closeDone = false,
    unclearDone = false,
    observed = false,
    lockFailure: unknown;
  const close = test
    .api(
      "/admin/accounting/month-close",
      { month, acknowledge_warnings: true, note: closeNote },
      201
    )
    .finally(() => {
      closeDone = true;
    });
  const unclear = test.api(unclearPath, unclearBody, [200, 423]).finally(() => {
    unclearDone = true;
  });
  const outcomes = Promise.allSettled([close, unclear]);
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      const waiters = await periodBlockedSessions(client);
      if (waiters >= 2) {
        observed = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 50));
    }
    test.check(
      observed && !closeDone && !unclearDone,
      "Real month close and zeroGL unclear share the period lock"
    );
  } catch (error) {
    lockFailure = error;
  } finally {
    await client.query("COMMIT");
  }
  const result = await outcomes;
  if (lockFailure) throw lockFailure;
  assert(
    result.every((row) => row.status === "fulfilled"),
    "Both competing operations reach their allowed result"
  );
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- mismo `itemId` verificado presente unas líneas arriba en este mismo opening propio del harness
  const current = (await test.opening(openingId)).items.find(
    (row) => row.id === itemId
  )!;
  const clearBody = {
    transaction_id: transactionId,
    expected_source_version: 1,
    expected_item_hash: current.source_hash,
  };
  const blocked = current.clear_id
    ? await test.api(
        unclearPath,
        { ...unclearBody, clear_id: current.clear_id },
        423
      )
    : await test.api(`${openingApiBase}/items/${itemId}/clear`, clearBody, 423);
  test.check(
    blocked.code === "BANKING_ACCOUNTING_PERIOD_CLOSED",
    "Committed month close blocks historical claim changes with zeroGL"
  );
  const preview = (
    await test.api(
      `/admin/accounting/month-close/reopen-preview?month=${month}`
    )
  ).preview as { input_hash: string };
  await test.api("/admin/accounting/month-close/reopen", {
    month,
    input_hash: preview.input_hash,
    reason: "Owned v10 month reopen",
  });
  if (!current.clear_id)
    await test.api(`${openingApiBase}/items/${itemId}/clear`, clearBody);
  test.check(
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- mismo `itemId` verificado presente arriba en este mismo opening propio del harness
    (await test.opening(openingId)).items.find((row) => row.id === itemId)!
      .transaction_id === transactionId,
    "Reopened period preserves or explicitly restores historical claim"
  );
  assert(
    (await client.query("SELECT 1 FROM bank_account WHERE id=$1", [account]))
      .rowCount,
    "Owned account remains present"
  );
}
