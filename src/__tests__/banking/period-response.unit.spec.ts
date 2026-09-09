/** A successful response must never escape before the accounting transaction commits. */
jest.mock("../../lib/accounting/month-close-auth", () => ({
  requireFullAdmin: jest.fn(async () => "test_accountant"),
  FullAdminRequiredError: class extends Error {},
}));
jest.mock("../../lib/accounting/month-close-data", () => ({
  parseMonth: () => ({ month: "2000-01", from: "2000-01-01T05:00:00Z", to: "2000-02-01T05:00:00Z",
    periodStart: "2000-01-01", periodEnd: "2000-02-01" }),
  loadMonthSummary: jest.fn(async () => ({})),
  loadOpenDocuments: jest.fn(async () => ({})),
  buildReadiness: () => ({ has_blockers: false, has_warnings: false }),
}));
jest.mock("../../lib/cost/inventory-snapshot", () => ({
  captureInventoryValuationSnapshot: jest.fn(async () => ({ snapshotId: "fixture_snapshot" })),
}));

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { POST } from "../../api/admin/accounting/month-close/route";

describe("Month Close commit/response boundary", () => {
  function harness(commitFails: boolean) {
    const events: string[] = [];
    const raw = jest.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO accounting_period_close")) return { rows: [{ id: "fixture_close" }] };
      return { rows: [] };
    });
    const db = {
      raw,
      transaction: async <T>(run: (client: { raw: typeof raw }) => Promise<T>): Promise<T> => {
        events.push("begin");
        const value = await run({ raw });
        if (commitFails) { events.push("rollback"); throw new Error("commit_failed"); }
        events.push("commit");
        return value;
      },
    };
    const response = { status: jest.fn(), json: jest.fn() };
    response.status.mockImplementation(() => response);
    response.json.mockImplementation(() => { events.push("response"); return response; });
    const request = { body: { month: "2000-01" }, scope: { resolve: () => db } };
    const run = () => POST(request as unknown as AuthenticatedMedusaRequest, response as unknown as MedusaResponse);
    return { run, events, response, raw };
  }

  it("sends success only after commit", async () => {
    const test = harness(false);
    await test.run();
    expect(test.events).toEqual(["begin", "commit", "response"]);
    expect(test.response.status).toHaveBeenCalledWith(201);
    expect(test.raw.mock.calls[0]?.[0]).toContain("pg_advisory_xact_lock");
  });

  it("never sends a successful response if commit fails", async () => {
    const test = harness(true);
    await expect(test.run()).rejects.toThrow("commit_failed");
    expect(test.events).toEqual(["begin", "rollback"]);
    expect(test.response.json).not.toHaveBeenCalled();
  });
});
