import { decideAddRetrySafety } from "../../lib/quickbooks/pipeline/add-retry-safety";

/**
 * QB `*Add` operations are NOT idempotent — re-sending one that already landed
 * mints a duplicate document. So an ADD may only be auto-retried when QuickBooks
 * itself ANSWERED with a rejection (nothing was created). When we never learned
 * the outcome — timeout, dropped connection, response without a TxnID — the row
 * must stop and stay visible instead of silently duplicating money.
 */
describe("decideAddRetrySafety", () => {
  describe("QuickBooks answered — nothing was created, retry is safe", () => {
    it("allows retry on the 3210 that failed CM-1105 → Invoice 21215", () => {
      const d = decideAddRetrySafety(
        'QB operation 51a06d82 failed: QuickBooks Error 3210: The "AppliedToTxnAdd credit amount" field has an invalid value "30.53".'
      );
      expect(d.safeToAutoRetry).toBe(true);
    });

    it("allows retry on a 3170 lock", () => {
      expect(
        decideAddRetrySafety("QuickBooks Error 3170: could not be locked")
          .safeToAutoRetry
      ).toBe(true);
    });

    it("allows retry on an invoice-not-found rejection", () => {
      expect(
        decideAddRetrySafety("QuickBooks Error 3120: does not exist")
          .safeToAutoRetry
      ).toBe(true);
    });
  });

  describe("outcome unknown — the ADD may already exist in QB", () => {
    it("blocks auto-retry when the poll timed out", () => {
      const d = decideAddRetrySafety(
        "Polling timed out for operation 51a06d82 after 40 attempts"
      );
      expect(d.safeToAutoRetry).toBe(false);
      expect(d.reason).toMatch(/unknown|reconcil/i);
    });

    it("blocks auto-retry when the bridge request itself timed out", () => {
      expect(
        decideAddRetrySafety(
          "Bridge POST /api/payments → timed out after 30000ms"
        ).safeToAutoRetry
      ).toBe(false);
    });

    it("blocks auto-retry on a dropped connection", () => {
      expect(
        decideAddRetrySafety("fetch failed: ECONNREFUSED").safeToAutoRetry
      ).toBe(false);
    });

    it("blocks auto-retry when the op completed without a TxnID", () => {
      // The most dangerous shape: QB ran it, we cannot tell what it produced.
      expect(
        decideAddRetrySafety("Operation completed but no TxnID in response")
          .safeToAutoRetry
      ).toBe(false);
    });

    it("blocks auto-retry when QBWC never picked the op up", () => {
      expect(
        decideAddRetrySafety("QBWC offline — qb desktop may be offline")
          .safeToAutoRetry
      ).toBe(false);
    });
  });

  it("always explains itself for the operator", () => {
    for (const msg of [
      "QuickBooks Error 3210: bad credit amount",
      "Polling timed out for operation abc",
    ]) {
      expect(decideAddRetrySafety(msg).reason.length).toBeGreaterThan(10);
    }
  });

  it("defaults to blocking when the error is empty or unrecognisable", () => {
    // Unknown shape → assume we do not know the outcome. Never duplicate on a guess.
    expect(decideAddRetrySafety("").safeToAutoRetry).toBe(false);
  });
});
