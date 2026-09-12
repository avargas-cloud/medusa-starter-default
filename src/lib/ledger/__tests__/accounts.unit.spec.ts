import { loadAccountMap, loadOpeningAccountMap } from "../accounts";
import { ACCOUNT_MAP_KEYS, LedgerError } from "../types";

/** Fake `PoolClient`: devuelve una fila de `gl_account_map` por cada key en `resolved`. */
function fakeClient(resolved: readonly string[]) {
  return {
    query: jest.fn(async () => ({
      rows: resolved.map((key) => ({
        key,
        account_snapshot: { id: `${key}-1`, name: key, account_type: "Equity", currency: "USD" },
        normal_balance: "credit",
      })),
    })),
  };
}

describe("account map — opening_balance_equity vive FUERA de las 9 keys históricas", () => {
  it("loadAccountMap exige las 9 y no sabe de opening_balance_equity", async () => {
    const map = await loadAccountMap(fakeClient(ACCOUNT_MAP_KEYS) as never);
    expect(map.accounts_receivable.id).toBe("accounts_receivable-1");
    expect((map as Record<string, unknown>).opening_balance_equity).toBeUndefined();
    expect(ACCOUNT_MAP_KEYS).not.toContain("opening_balance_equity");
  });

  it("loadAccountMap falla GL_ACCOUNT_MAP_MISSING si falta una de las 9", async () => {
    await expect(
      loadAccountMap(fakeClient(ACCOUNT_MAP_KEYS.filter((k) => k !== "bad_debt")) as never)
    ).rejects.toThrow(LedgerError);
  });

  it("loadOpeningAccountMap exige las 9 + opening_balance_equity", async () => {
    const map = await loadOpeningAccountMap(fakeClient([...ACCOUNT_MAP_KEYS, "opening_balance_equity"]) as never);
    expect(map.opening_balance_equity.id).toBe("opening_balance_equity-1");
    await expect(loadOpeningAccountMap(fakeClient(ACCOUNT_MAP_KEYS) as never)).rejects.toMatchObject({
      code: "GL_ACCOUNT_MAP_MISSING",
    });
  });
});
