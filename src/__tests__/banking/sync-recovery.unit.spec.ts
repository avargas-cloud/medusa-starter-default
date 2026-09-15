/**
 * Frescura del feed sin refresh pago (2026-09-15): el webhook es el disparador primario y
 * el poll de recuperación la red de abajo. Este spec fija dos cosas que un type-check no ve:
 * (1) el intervalo de recuperación viaja como parámetro y es ≤ 2 h (era `interval '6 hours'`
 * pegado en el SQL); (2) el sync persiste `provider_last_update_at` desde el mismo valor
 * que ya usaba para cerrar refreshes, sin pisarlo con NULL cuando Plaid no lo manda.
 */
const queries: Array<{ text: string; values: unknown[] | undefined }> = [];

jest.mock("../../api/utils/db-pool", () => ({
  getDbPool: () => ({
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      return { rows: [] };
    },
  }),
}));

import { BANK_SYNC_RECOVERY_INTERVAL, syncPendingBanks } from "../../lib/banking/sync";

const sandboxUrl = "postgresql://fixture:fixture@127.0.0.1:5499/medusa";
const envKeys = ["ECOPOWERTECH_ENV", "DATABASE_URL", "BANKING_ENABLED", "BANKING_ENV"] as const;
let savedEnv: Partial<Record<(typeof envKeys)[number], string>>;

beforeEach(() => {
  queries.length = 0;
  savedEnv = {};
  for (const name of envKeys) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.ECOPOWERTECH_ENV = "sandbox";
  process.env.DATABASE_URL = sandboxUrl;
  process.env.BANKING_ENABLED = "true";
});

afterEach(() => {
  for (const name of envKeys) {
    const saved = savedEnv[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
});

describe("bank feed recovery poll", () => {
  it("polls every connection not synced within the recovery interval, bound as a parameter", async () => {
    await syncPendingBanks();
    const candidates = queries.find((q) => q.text.includes("FROM bank_connection c"));
    expect(candidates).toBeDefined();
    expect(candidates!.text).toContain("c.last_successful_sync_at < now()-$1::interval");
    expect(candidates!.text).not.toMatch(/interval '\d+ hours'/);
    expect(candidates!.values).toEqual([BANK_SYNC_RECOVERY_INTERVAL]);
  });

  it("keeps the recovery interval at two hours or less (a /transactions/sync poll is free)", () => {
    const match = /^(\d+) (hour|hours|minutes?)$/.exec(BANK_SYNC_RECOVERY_INTERVAL);
    expect(match).not.toBeNull();
    const [, n, unit] = match!;
    const hours = unit.startsWith("hour") ? Number(n) : Number(n) / 60;
    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThanOrEqual(2);
  });
});

describe("provider last update persistence", () => {
  it("stores Plaid's last_successful_update on the connection without erasing it when absent", () => {
    // El UPDATE vive dentro de un lock + transacción que este spec no ejercita: se afirma la
    // sentencia emitida por el módulo, y la migración de la columna se prueba en el clon.
    const source = require("node:fs").readFileSync(require.resolve("../../lib/banking/sync"), "utf8") as string;
    const update = source
      .split("\n")
      .filter((line) => /UPDATE bank_connection SET status='active'/.test(line) || /provider_last_update_at=/.test(line))
      .join("\n");
    expect(update).toContain("UPDATE bank_connection SET status='active'");
    expect(update).toContain("provider_last_update_at=COALESCE($4::timestamptz,provider_last_update_at)");
  });
});
