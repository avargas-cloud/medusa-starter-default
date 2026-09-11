/** Real historical Month Close racing a zero-GL opening clear correction. */
import type { PoolClient } from "pg";

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

// `openingPeriodChecks` (Month Close racing an opening-item unclear via the
// retired /admin/banking/accounting/openings/items/:id/(un)clear routes) was
// removed here: it is dead code (no suite imports it, confirmed by grep) built
// entirely around opening-item concepts (clear_id, .opening(), per-item
// unclear/clear) that no longer exist. periodBlockedSessions above, which
// every calling suite DOES use, is untouched.
