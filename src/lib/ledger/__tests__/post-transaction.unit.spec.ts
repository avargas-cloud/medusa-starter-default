import { runInPostingTransaction } from "../post";

/** Fake `PoolClient` — sólo implementa `.query()` y graba la secuencia de SQL. */
function fakeClient(opts: { savepointFails: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    query: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (opts.savepointFails && sql === "SAVEPOINT gl_post") {
        const err = new Error(
          'no existe una transacción SQL activa: SAVEPOINT no está permitido fuera de un bloque de transacción'
        ) as Error & { code: string };
        err.code = "25P01";
        throw err;
      }
      return { rows: [] };
    }),
  };
}

describe("runInPostingTransaction", () => {
  it("owns its own transaction when the caller has none open (SAVEPOINT rejected with 25P01)", async () => {
    const client = fakeClient({ savepointFails: true });
    const result = await runInPostingTransaction(client as never, async () => "posted");
    expect(result).toBe("posted");
    expect(client.calls).toEqual(["SAVEPOINT gl_post", "BEGIN", "COMMIT"]);
  });

  it("rolls back its own transaction on failure when it owns it", async () => {
    const client = fakeClient({ savepointFails: true });
    await expect(
      runInPostingTransaction(client as never, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(client.calls).toEqual(["SAVEPOINT gl_post", "BEGIN", "ROLLBACK"]);
  });

  it("participates in the caller's transaction when SAVEPOINT succeeds", async () => {
    const client = fakeClient({ savepointFails: false });
    const result = await runInPostingTransaction(client as never, async () => "posted");
    expect(result).toBe("posted");
    expect(client.calls).toEqual(["SAVEPOINT gl_post", "RELEASE SAVEPOINT gl_post"]);
  });

  it("rolls back only to its savepoint on failure inside a caller-owned transaction", async () => {
    const client = fakeClient({ savepointFails: false });
    await expect(
      runInPostingTransaction(client as never, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(client.calls).toEqual(["SAVEPOINT gl_post", "ROLLBACK TO SAVEPOINT gl_post"]);
  });

  it("rethrows a SAVEPOINT failure that is NOT the no-active-transaction SQLSTATE", async () => {
    const client = {
      query: jest.fn(async () => {
        const err = new Error("syntax error") as Error & { code: string };
        err.code = "42601";
        throw err;
      }),
    };
    await expect(
      runInPostingTransaction(client as never, async () => "unreachable")
    ).rejects.toThrow("syntax error");
  });
});
