import { loadAccountMap } from "../accounts";
import { ACCOUNT_MAP_KEYS, AccountMapKey, LedgerError } from "../types";

/** Fake `PoolClient`: devuelve una fila de `gl_account_map` por cada key en `resolved`. */
function fakeClient(resolved: AccountMapKey[]) {
  return {
    query: jest.fn(async () => ({
      rows: resolved.map((key) => ({
        key,
        account_snapshot: {
          id: `${key}-1`,
          name: key,
          account_type: "Equity",
          currency: "USD",
        },
        normal_balance: "credit",
      })),
    })),
  };
}

describe("loadAccountMap — required keys opcionales", () => {
  it("default (sin `required`) exige las 9 keys históricas, no `opening_balance_equity`", async () => {
    const nineKeys = ACCOUNT_MAP_KEYS.filter((k) => k !== "opening_balance_equity");
    const client = fakeClient(nineKeys);
    const map = await loadAccountMap(client as never);
    expect(map.accounts_receivable.id).toBe("accounts_receivable-1");
    expect(map.opening_balance_equity).toBeUndefined();
  });

  it("falla GL_ACCOUNT_MAP_MISSING si falta una de las 9 keys históricas (default)", async () => {
    const client = fakeClient(
      ACCOUNT_MAP_KEYS.filter((k) => k !== "opening_balance_equity" && k !== "bad_debt")
    );
    await expect(loadAccountMap(client as never)).rejects.toThrow(LedgerError);
  });

  it("no falla si sólo falta `opening_balance_equity` y nadie la pide", async () => {
    const client = fakeClient(ACCOUNT_MAP_KEYS.filter((k) => k !== "opening_balance_equity"));
    await expect(loadAccountMap(client as never)).resolves.toBeDefined();
  });

  it("con `required: ['opening_balance_equity']` exige esa key y NINGUNA otra", async () => {
    const client = fakeClient(["opening_balance_equity"]);
    const map = await loadAccountMap(client as never, ["opening_balance_equity"]);
    expect(map.opening_balance_equity.id).toBe("opening_balance_equity-1");
    expect(map.accounts_receivable).toBeUndefined();
  });

  it("falla GL_ACCOUNT_MAP_MISSING si se pide `opening_balance_equity` y no resuelve", async () => {
    const client = fakeClient([]);
    await expect(
      loadAccountMap(client as never, ["opening_balance_equity"])
    ).rejects.toThrow(LedgerError);
  });
});
