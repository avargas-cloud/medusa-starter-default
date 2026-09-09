import { feedTransaction, fetchFeedBatch } from "../../lib/banking/feed";
import { BankingError } from "../../lib/banking/security";

function row(id = "tx-one", overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: id, account_id: "account-one", pending_transaction_id: null,
    amount: "123.4500", iso_currency_code: "USD", unofficial_currency_code: null,
    date: "2026-09-08", authorized_date: null, name: "Fixture merchant",
    merchant_name: null, pending: false, original_description: "Provider evidence",
    ...overrides,
  };
}

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    added: [], modified: [], removed: [], has_more: false, next_cursor: "cursor-done",
    transactions_update_status: "HISTORICAL_UPDATE_COMPLETE", ...overrides,
  };
}

function provider() {
  return jest.fn<Promise<Record<string, unknown>>, [string, Record<string, unknown>]>();
}

describe("complete bank feed pagination", () => {
  it("collects two pages with all change kinds and the final completeness marker", async () => {
    const request = provider()
      .mockResolvedValueOnce(page({ added: [row()], next_cursor: "cursor-page-one", has_more: true,
        transactions_update_status: "INITIAL_UPDATE_COMPLETE" }))
      .mockResolvedValueOnce(page({ modified: [row("tx-two")], removed: [{ transaction_id: "tx-old", account_id: "account-one" }] }));
    const result = await fetchFeedBatch("fixture-access", "cursor-origin", request);
    expect(request.mock.calls.map((call) => call[1].cursor)).toEqual(["cursor-origin", "cursor-page-one"]);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["/transactions/sync", "/transactions/sync"]);
    expect(result.added.map((tx) => tx.transaction_id)).toEqual(["tx-one"]);
    expect(result.modified.map((tx) => tx.transaction_id)).toEqual(["tx-two"]);
    expect(result.removed).toEqual([{ transaction_id: "tx-old", account_id: "account-one" }]);
    expect(result).toMatchObject({ cursor: "cursor-done", initialComplete: true, historicalComplete: true });
  });

  it("restarts from the original cursor and discards every page from an invalidated traversal", async () => {
    const request = provider()
      .mockResolvedValueOnce(page({ added: [row("discard-me")], has_more: true, next_cursor: "page-one" }))
      .mockRejectedValueOnce(new BankingError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 502))
      .mockResolvedValueOnce(page({ added: [row("keep-one")], has_more: true, next_cursor: "page-one" }))
      .mockResolvedValueOnce(page({ modified: [row("keep-two")] }));
    const result = await fetchFeedBatch("fixture-access", "cursor-origin", request);
    expect(request.mock.calls.map((call) => call[1].cursor)).toEqual(["cursor-origin", "page-one", "cursor-origin", "page-one"]);
    expect(result.added.map((tx) => tx.transaction_id)).toEqual(["keep-one"]);
    expect(result.modified.map((tx) => tx.transaction_id)).toEqual(["keep-two"]);
    expect(JSON.stringify(result)).not.toContain("discard-me");
  });

  it("bounds repeated pagination mutation failures to three traversals", async () => {
    const request = provider().mockRejectedValue(new BankingError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", 502));
    await expect(fetchFeedBatch("fixture-access", "original", request)).rejects.toMatchObject({ code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every((call) => call[1].cursor === "original")).toBe(true);
  });

  it("does not turn a provider failure on page two into a partial successful batch", async () => {
    const request = provider()
      .mockResolvedValueOnce(page({ added: [row()], has_more: true, next_cursor: "page-two" }))
      .mockRejectedValueOnce(new BankingError("ITEM_LOGIN_REQUIRED", 502));
    await expect(fetchFeedBatch("fixture-access", null, request)).rejects.toMatchObject({ code: "ITEM_LOGIN_REQUIRED" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("cursor");
  });

  it.each([undefined, "NOT_READY", "UNKNOWN_FUTURE_STATE"])("does not claim an empty initial feed is synchronized for status %#", async (status) => {
    const request = provider().mockResolvedValue(page({ transactions_update_status: status }));
    await expect(fetchFeedBatch("fixture-access", null, request)).resolves.toMatchObject({
      added: [], modified: [], removed: [], initialComplete: false, historicalComplete: false,
    });
  });

  it("distinguishes initial-ready from historical-ready even when there are no transactions", async () => {
    const request = provider().mockResolvedValue(page({ transactions_update_status: "INITIAL_UPDATE_COMPLETE" }));
    await expect(fetchFeedBatch("fixture-access", null, request)).resolves.toMatchObject({ initialComplete: true, historicalComplete: false });
  });

  it.each([
    { added: null }, { modified: {} }, { removed: "[]" }, { has_more: "false" }, { next_cursor: null },
  ])("rejects a malformed page %#", async (malformed) => {
    const request = provider().mockResolvedValue(page(malformed));
    await expect(fetchFeedBatch("fixture-access", null, request)).rejects.toMatchObject({ code: "BANKING_PROVIDER_INVALID_RESPONSE" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["origin", ""])("rejects a nonadvancing cursor %# before fetching another page", async (cursor) => {
    const request = provider().mockResolvedValue(page({ has_more: true, next_cursor: cursor }));
    await expect(fetchFeedBatch("fixture-access", "origin", request)).rejects.toMatchObject({ code: "BANKING_CURSOR_NOT_ADVANCING" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a loop cycling across different cursors as soon as a cursor repeats", async () => {
    let call = 0;
    const request = provider().mockImplementation(async () => page({ has_more: true, next_cursor: ++call % 2 ? "loop-a" : "loop-b" }));
    await expect(fetchFeedBatch("fixture-access", "origin", request)).rejects.toMatchObject({ code: "BANKING_CURSOR_NOT_ADVANCING" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("still bounds a provider that offers endless distinct pages", async () => {
    let call = 0;
    const request = provider().mockImplementation(async () => page({ has_more: true, next_cursor: `page-${++call}` }));
    await expect(fetchFeedBatch("fixture-access", "origin", request)).rejects.toMatchObject({ code: "BANKING_PAGE_LIMIT_REACHED" });
    expect(request).toHaveBeenCalledTimes(100);
  });

  it.each([null, undefined])("accepts a removal without a provider account reference %#", async (accountId) => {
    const request = provider().mockResolvedValue(page({ removed: [{ transaction_id: "gone", account_id: accountId }] }));
    await expect(fetchFeedBatch("fixture-access", null, request)).resolves.toMatchObject({ removed: [{ transaction_id: "gone" }] });
  });

  it.each([123, false, {}, "", "   "])("rejects a malformed account reference on a removal %#", async (accountId) => {
    const request = provider().mockResolvedValue(page({ removed: [{ transaction_id: "gone", account_id: accountId }] }));
    await expect(fetchFeedBatch("fixture-access", null, request)).rejects.toMatchObject({ code: "BANKING_PROVIDER_INVALID_RESPONSE" });
  });

  it("stops a batch exceeding the maximum observations before returning it", async () => {
    const request = provider().mockResolvedValue(page({ added: Array.from({ length: 10001 }, (_, i) => row(`tx-${i}`)) }));
    await expect(fetchFeedBatch("fixture-access", null, request)).rejects.toMatchObject({ code: "BANKING_SANDBOX_BATCH_LIMIT" });
  });
});

describe("bank transaction source validation", () => {
  it("preserves exact decimal text, raw source fields, and unknown currency without inventing USD", () => {
    const source = row("exact", { amount: "-12345678901234567890.0123456789", iso_currency_code: null, unofficial_currency_code: "X-TEST", pending: true });
    const before = JSON.stringify(source);
    expect(feedTransaction(source)).toMatchObject({ amount: source.amount, currency: null, unofficial_currency: "X-TEST", pending: true, source });
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each([0, -7.25, "0.00", "-0.01"])("accepts valid provider amount %# without cents conversion", (amount) => {
    expect(feedTransaction(row("amount", { amount })).amount).toBe(String(amount));
  });

  it.each([null, true, {}, "", " 1.20", "1,000.00", "1e3", "NaN", NaN, Infinity, 1e21, "1".repeat(41)])("rejects malformed amount %#", (amount) => {
    expect(() => feedTransaction(row("amount", { amount }))).toThrow(expect.objectContaining({ code: "BANKING_INVALID_AMOUNT" }));
  });

  it.each(["2026-02-30", "2026-9-08", "2026-13-08", "not-a-date"])("rejects impossible or malformed date %# with a controlled error", (date) => {
    expect(() => feedTransaction(row("date", { date }))).toThrow(expect.objectContaining({ code: "BANKING_INVALID_DATE" }));
  });

  it.each(["false", 0, null])("rejects nonboolean pending status %#", (pending) => {
    expect(() => feedTransaction(row("pending", { pending }))).toThrow(expect.objectContaining({ code: "BANKING_INVALID_TRANSACTION" }));
  });

  it("rejects a transaction lacking a usable provider identity", () => {
    expect(() => feedTransaction(row("", {}))).toThrow(BankingError);
    expect(() => feedTransaction(row("one", { account_id: null }))).toThrow(BankingError);
  });
});
