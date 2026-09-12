/**
 * Semantics of the global QB_SYNC_ENABLED switch (src/lib/quickbooks/sync-enabled.ts).
 *
 * Unset (or any value not in the recognized "off" list) must mean ENABLED —
 * production must not change behavior until an operator explicitly flips the
 * env var. Only "false"/"0"/"off" (case-insensitive, trimmed) turn it off.
 */
import { isQbSyncEnabled, QbSyncDisabledError } from "../../lib/quickbooks/sync-enabled";

describe("isQbSyncEnabled", () => {
  const ORIGINAL = process.env.QB_SYNC_ENABLED;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.QB_SYNC_ENABLED;
    else process.env.QB_SYNC_ENABLED = ORIGINAL;
  });

  it("unset → enabled (fail-open default)", () => {
    delete process.env.QB_SYNC_ENABLED;
    expect(isQbSyncEnabled()).toBe(true);
  });

  it('"true" → enabled', () => {
    process.env.QB_SYNC_ENABLED = "true";
    expect(isQbSyncEnabled()).toBe(true);
  });

  it("an unrecognized value → enabled (never fails closed on a typo)", () => {
    process.env.QB_SYNC_ENABLED = "disabled";
    expect(isQbSyncEnabled()).toBe(true);
  });

  it.each(["false", "0", "off", "FALSE", " false "])(
    "%p → disabled",
    (value) => {
      process.env.QB_SYNC_ENABLED = value;
      expect(isQbSyncEnabled()).toBe(false);
    }
  );
});

describe("QbSyncDisabledError", () => {
  it("carries a stable code", () => {
    const err = new QbSyncDisabledError();
    expect(err.code).toBe("QB_SYNC_DISABLED");
    expect(err.name).toBe("QbSyncDisabledError");
    expect(err).toBeInstanceOf(Error);
  });
});
