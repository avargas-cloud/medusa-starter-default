/**
 * `bridgeFetch` (both the `../bridge-fetch.ts` client and the independent
 * `client/core.ts` client — a SEPARATE fetch implementation used by the
 * `client/*.ts` bridge modules) must throw `QbSyncDisabledError` BEFORE any
 * network call when QB_SYNC_ENABLED=false.
 */
import { bridgeFetch as bridgeFetchTop } from "../../lib/quickbooks/bridge-fetch";
import { bridgeFetch as bridgeFetchCore } from "../../lib/quickbooks/client/core";
import { QbSyncDisabledError } from "../../lib/quickbooks/sync-enabled";

describe("bridgeFetch gate — QB_SYNC_ENABLED=false", () => {
  const ORIGINAL_SYNC = process.env.QB_SYNC_ENABLED;
  const ORIGINAL_FETCH = global.fetch;

  beforeEach(() => {
    process.env.QB_SYNC_ENABLED = "false";
    // If the gate didn't fire, this spy would be hit — proof of "before any
    // network call", not just "eventually rejects".
    global.fetch = jest.fn(() => {
      throw new Error("bridgeFetch reached the network — gate did not fire");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    if (ORIGINAL_SYNC === undefined) delete process.env.QB_SYNC_ENABLED;
    else process.env.QB_SYNC_ENABLED = ORIGINAL_SYNC;
    global.fetch = ORIGINAL_FETCH;
    jest.restoreAllMocks();
  });

  it("bridge-fetch.ts's bridgeFetch throws QbSyncDisabledError without calling fetch", async () => {
    await expect(bridgeFetchTop("/api/sync/status/op_1")).rejects.toBeInstanceOf(
      QbSyncDisabledError
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("client/core.ts's bridgeFetch throws QbSyncDisabledError without calling fetch", async () => {
    await expect(
      bridgeFetchCore("GET", "/api/sync/queue-stats")
    ).rejects.toBeInstanceOf(QbSyncDisabledError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
