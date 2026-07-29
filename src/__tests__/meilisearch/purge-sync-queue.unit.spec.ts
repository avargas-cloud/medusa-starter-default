/**
 * The `meili_sync_queue` retention purge.
 *
 * The database is faked here on purpose: what these tests protect is not that
 * Postgres can delete a row, it is the two properties that make the purge safe
 * to point at production — that no statement can reach a row with
 * `processed_at IS NULL`, and that the batch loop advances and terminates. Both
 * are properties of the SQL this module emits, so asserting on the emitted
 * statements is a tighter test than a live table would be.
 *
 * The live behaviour (real rows, real triggers, the processor still draining
 * afterwards) is covered by the sandbox E2E, not here.
 */
import type { Sql } from "postgres";

import {
  DEFAULT_RETENTION_DAYS,
  assertRetentionDays,
  formatPurgeResult,
  purgeSyncQueue,
  resolveRetentionDays,
} from "../../lib/meilisearch/purge-sync-queue";

const CUTOFF = "2026-06-29 12:00:00+00";

interface Recorded {
  text: string;
  values: unknown[];
}

/**
 * A stand-in for postgres.js's tagged template. Records every statement and
 * answers from a simulated table of eligible ids.
 */
function fakeSql(eligibleIds: number[]) {
  const calls: Recorded[] = [];
  const remaining = [...eligibleIds].sort((a, b) => a - b);

  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });

    if (text.includes("make_interval")) {
      return Promise.resolve([{ cutoff: CUTOFF }]);
    }
    if (text.includes("count(*)")) {
      return Promise.resolve([{ eligible: String(remaining.length) }]);
    }
    if (text.includes("DELETE")) {
      const cursor = Number(values[0]);
      const limit = Number(values[2]);
      const taken = remaining.filter((id) => id > cursor).slice(0, limit);
      for (const id of taken) remaining.splice(remaining.indexOf(id), 1);
      return Promise.resolve(taken.map((id) => ({ id: String(id) })));
    }
    throw new Error(`unexpected statement: ${text}`);
  };

  return {
    sql: tag as unknown as Sql,
    calls,
    statementsTouchingQueue: () =>
      calls.filter((c) => c.text.includes("meili_sync_queue")),
    deletes: () => calls.filter((c) => c.text.includes("DELETE")),
    rowsLeft: () => remaining,
  };
}

describe("retention window validation", () => {
  it("accepts a whole number of days >= 1", () => {
    expect(assertRetentionDays(1)).toBe(1);
    expect(assertRetentionDays(30)).toBe(30);
  });

  // 0 would mean "delete every processed row" and a negative would reach into
  // the future. Both are one typo away in an env var, so this refuses rather
  // than silently falling back to the default.
  it.each([0, -7, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %p instead of guessing",
    (bad) => {
      expect(() => assertRetentionDays(bad)).toThrow(/whole number >= 1/);
    }
  );

  it("falls back to the default only when the env var is absent or blank", () => {
    expect(resolveRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays("")).toBe(DEFAULT_RETENTION_DAYS);
    expect(resolveRetentionDays("   ")).toBe(DEFAULT_RETENTION_DAYS);
  });

  it("reads a valid override", () => {
    expect(resolveRetentionDays("14")).toBe(14);
  });

  it.each(["0", "-7", "abc", "1.5"])("rejects the env value %p", (bad) => {
    expect(() => resolveRetentionDays(bad)).toThrow();
  });
});

describe("the invariant that keeps this safe to run against production", () => {
  it("never emits a statement that could reach an unprocessed row", async () => {
    const db = fakeSql([1, 2, 3, 4, 5]);
    await purgeSyncQueue(db.sql, { retentionDays: 30, batchSize: 2, pauseMs: 0 });

    const touching = db.statementsTouchingQueue();
    expect(touching.length).toBeGreaterThan(0);
    for (const call of touching) {
      expect(call.text).toContain("processed_at IS NOT NULL");
    }
  });

  it("scopes every batch by the cutoff, not just the first one", async () => {
    const db = fakeSql([1, 2, 3, 4, 5]);
    await purgeSyncQueue(db.sql, { retentionDays: 30, batchSize: 2, pauseMs: 0 });

    for (const call of db.deletes()) {
      expect(call.text).toContain("processed_at <");
      expect(call.values).toContain(CUTOFF);
    }
  });

  it("resolves the cutoff once and reuses it, so a run is reproducible", async () => {
    const db = fakeSql([1, 2, 3, 4, 5]);
    const result = await purgeSyncQueue(db.sql, { retentionDays: 30, batchSize: 2, pauseMs: 0 });

    const cutoffQueries = db.calls.filter((c) => c.text.includes("make_interval"));
    expect(cutoffQueries).toHaveLength(1);
    expect(result.cutoff).toBe(CUTOFF);
  });
});

describe("dry run", () => {
  it("reports the write set and issues no DELETE at all", async () => {
    const db = fakeSql([1, 2, 3, 4, 5]);
    const result = await purgeSyncQueue(db.sql, { retentionDays: 30, dryRun: true });

    expect(result.eligible).toBe(5);
    expect(result.deleted).toBe(0);
    expect(result.batches).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(db.deletes()).toHaveLength(0);
    expect(db.rowsLeft()).toHaveLength(5);
  });
});

describe("the batch loop", () => {
  it("deletes the whole eligible set across committed batches", async () => {
    const db = fakeSql(Array.from({ length: 2500 }, (_, i) => i + 1));
    const result = await purgeSyncQueue(db.sql, {
      retentionDays: 30,
      batchSize: 1000,
      pauseMs: 0,
    });

    expect(result.eligible).toBe(2500);
    expect(result.deleted).toBe(2500);
    expect(result.batches).toBe(3);
    expect(db.rowsLeft()).toHaveLength(0);
  });

  it("advances the cursor past gaps instead of rescanning them", async () => {
    // Ids 4..99 are missing from the eligible set — that is what a dead-letter
    // row parked at the front of the table looks like. Without a cursor the
    // loop would re-scan them on every batch; with a broken cursor it would
    // never terminate.
    const db = fakeSql([1, 2, 3, 100, 101]);
    const result = await purgeSyncQueue(db.sql, {
      retentionDays: 30,
      batchSize: 2,
      pauseMs: 0,
    });

    expect(result.deleted).toBe(5);
    const cursors = db.deletes().map((c) => Number(c.values[0]));
    expect(cursors).toEqual([0, 2, 100]);
    // Strictly increasing — the property that guarantees termination.
    for (let i = 1; i < cursors.length; i += 1) {
      expect(cursors[i]).toBeGreaterThan(cursors[i - 1] as number);
    }
  });

  it("stops at the row cap and says so, leaving the rest for the next run", async () => {
    const db = fakeSql(Array.from({ length: 500 }, (_, i) => i + 1));
    const result = await purgeSyncQueue(db.sql, {
      retentionDays: 30,
      batchSize: 100,
      maxRows: 250,
      pauseMs: 0,
    });

    expect(result.deleted).toBe(250);
    expect(result.cappedByMaxRows).toBe(true);
    expect(db.rowsLeft()).toHaveLength(250);
  });

  it("is a no-op on an already-clean table, so re-running is free", async () => {
    const db = fakeSql([]);
    const result = await purgeSyncQueue(db.sql, { retentionDays: 30, pauseMs: 0 });

    expect(result.eligible).toBe(0);
    expect(result.deleted).toBe(0);
    expect(db.deletes()).toHaveLength(0);
  });
});

describe("the log line", () => {
  it("carries the numbers an operator needs to audit the run after the fact", async () => {
    const db = fakeSql([1, 2, 3]);
    const result = await purgeSyncQueue(db.sql, { retentionDays: 30, pauseMs: 0 });
    const line = formatPurgeResult(result);

    expect(line).toContain("retention=30d");
    expect(line).toContain(`cutoff=${CUTOFF}`);
    expect(line).toContain("eligible=3");
    expect(line).toContain("deleted=3");
  });

  it("marks a dry run so it can never be mistaken for a real one", async () => {
    const db = fakeSql([1, 2, 3]);
    const result = await purgeSyncQueue(db.sql, { retentionDays: 30, dryRun: true });

    expect(formatPurgeResult(result)).toMatch(/^DRY-RUN /);
  });
});
