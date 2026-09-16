/**
 * "Request update" (2026-09-16): one supervisor PIN authorizes N billed Plaid refreshes.
 * What a type-check cannot see: (1) a rejected PIN never reaches Plaid; (2) a bank whose
 * data Plaid already pulled TODAY (ET) is refused by the ROUTE, not just greyed out in the
 * modal; (3) a cooldown on one bank does not stop the others; (4) an invalid selection is
 * rejected before any billing.
 */
const plaidRequest = jest.fn(async () => ({}));
const guardSupervisorPin = jest.fn();
const fixtures: Record<string, { refresh_requested_at: Date | null; updated_today: boolean }> = {};

jest.mock("../../lib/banking/plaid", () => ({ plaidRequest: (...args: unknown[]) => plaidRequest(...(args as [])) }));
jest.mock("../../lib/banking/auth", () => ({ bankAccess: jest.fn(async () => undefined) }));
jest.mock("../../lib/banking/accounts", () => ({ selectedAccountRows: jest.fn(), saveAccounts: jest.fn() }));
jest.mock("../../lib/banking/review-common", () => ({ withReviewLock: jest.fn() }));
jest.mock("../../lib/banking/review-setup", () => ({ requireUnpostedBankAccount: jest.fn() }));
jest.mock("../../lib/banking/sync", () => ({ syncBank: jest.fn() }));
jest.mock("../../api/utils/db-pool", () => ({ getDbPool: () => ({}) }));
jest.mock("../../lib/pos/verify-supervisor-pin", () => ({ pgAsPinConn: () => ({}) }));
jest.mock("../../lib/pos/supervisor-pin-guard", () => ({
  guardSupervisorPin: (...args: unknown[]) => guardSupervisorPin(...(args as [])),
  extractSupervisorPin: () => "0000",
  resolveActorId: () => "user_fixture",
  pinGuardResponse: () => ({ status: 403, body: { code: "SUPERVISOR_PIN_INVALID" } }),
}));
jest.mock("../../lib/banking/security", () => {
  const actual = jest.requireActual("../../lib/banking/security");
  return {
    ...actual,
    requireBankingEnabled: () => undefined,
    manualRefreshAllowed: () => true,
    bankingEnvSql: () => "'sandbox'",
    bankingTokenKey: () => "fixture_key",
    decryptBankToken: (_enc: string, id: string) => `token_${id}`,
  };
});
jest.mock("../../lib/banking/store", () => ({
  connectionRow: async (_client: unknown, id: string) => ({
    id, access_token_encrypted: "enc", status: "active",
    refresh_requested_at: fixtures[id]?.refresh_requested_at ?? null,
  }),
  withBankLock: async (_id: string, work: (client: unknown) => Promise<unknown>) =>
    work({
      query: async (text: string, values: unknown[]) => {
        if (text.includes("provider_last_update_at"))
          return { rows: [{ today: fixtures[String(values[0])]?.updated_today === true }] };
        return { rows: [], rowCount: 1 };
      },
    }),
  transaction: async (client: unknown, run: (c: unknown) => Promise<unknown>) => run(client),
}));

import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { POST } from "../../api/admin/banking/connections/refresh/route";

function call(body: unknown) {
  const response = { status: jest.fn(), json: jest.fn() };
  response.status.mockImplementation(() => response);
  response.json.mockImplementation(() => response);
  const request = { body, scope: { resolve: () => ({}) }, headers: {}, params: {} };
  return POST(request as unknown as AuthenticatedMedusaRequest, response as unknown as MedusaResponse).then(() => ({
    status: response.status.mock.calls[0]?.[0] as number,
    body: response.json.mock.calls[0]?.[0] as { results?: Array<{ connection_id: string; status: string }> ; code?: string },
  }));
}

beforeEach(() => {
  plaidRequest.mockClear();
  guardSupervisorPin.mockReset();
  for (const key of Object.keys(fixtures)) delete fixtures[key];
  fixtures.a = { refresh_requested_at: null, updated_today: false };
  fixtures.b = { refresh_requested_at: null, updated_today: false };
});

describe("POST /admin/banking/connections/refresh", () => {
  it("a rejected PIN never reaches Plaid", async () => {
    guardSupervisorPin.mockResolvedValue({ ok: false, reason: "invalid", attemptsLeft: 7 });
    const out = await call({ connection_ids: ["a", "b"] });
    expect(out.status).toBe(403);
    expect(plaidRequest).not.toHaveBeenCalled();
  });

  it("one PIN check, one billed refresh per selected bank", async () => {
    guardSupervisorPin.mockResolvedValue({ ok: true, via: "pin" });
    const out = await call({ connection_ids: ["a", "b"] });
    expect(out.status).toBe(202);
    expect(guardSupervisorPin).toHaveBeenCalledTimes(1);
    expect(plaidRequest).toHaveBeenCalledTimes(2);
    expect(plaidRequest.mock.calls.map((c: unknown[]) => c[0])).toEqual(["/transactions/refresh", "/transactions/refresh"]);
    expect(out.body.results?.map((r) => r.status)).toEqual(["requested", "requested"]);
  });

  it("a bank already updated today is refused by the route and not billed", async () => {
    guardSupervisorPin.mockResolvedValue({ ok: true, via: "pin" });
    fixtures.b.updated_today = true;
    const out = await call({ connection_ids: ["a", "b"] });
    expect(out.status).toBe(202);
    expect(plaidRequest).toHaveBeenCalledTimes(1);
    expect(out.body.results).toEqual([
      { connection_id: "a", status: "requested", error_code: null },
      { connection_id: "b", status: "up_to_date", error_code: "BANKING_REFRESH_UP_TO_DATE" },
    ]);
  });

  it("a cooldown on one bank does not stop the others", async () => {
    guardSupervisorPin.mockResolvedValue({ ok: true, via: "pin" });
    fixtures.a.refresh_requested_at = new Date();
    const out = await call({ connection_ids: ["a", "b"] });
    expect(plaidRequest).toHaveBeenCalledTimes(1);
    expect(out.body.results?.map((r) => r.status)).toEqual(["cooldown", "requested"]);
  });

  it("an empty or oversized selection is rejected before billing", async () => {
    guardSupervisorPin.mockResolvedValue({ ok: true, via: "pin" });
    expect((await call({ connection_ids: [] })).status).toBe(400);
    expect((await call({ connection_ids: Array.from({ length: 11 }, (_, i) => `c${i}`) })).status).toBe(400);
    expect(plaidRequest).not.toHaveBeenCalled();
  });
});
