import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { getDbPool } from "../../api/utils/db-pool";
import { reviewAccess, type ReviewCapability } from "../../lib/banking/review-permissions";

jest.mock("../../api/utils/db-pool", () => ({ getDbPool: jest.fn() }));
jest.mock("../../modules/pos-user", () => ({ POS_USER_MODULE: "pos_user" }));

const query = jest.fn();
const saved: Record<string, string | undefined> = {};
const keys = ["ECOPOWERTECH_ENV", "DATABASE_URL"] as const;
function request(accounting = false, admin = false): AuthenticatedMedusaRequest {
  return { auth_context: { actor_id: "staff-fixture" }, scope: {
    resolve: (key: string) => key === "user"
      ? { retrieveUser: async () => ({ email: "staff@example.test" }) }
      : { listPosUsers: async () => admin ? [] : [{ can_view_accounting: accounting }] },
  } } as unknown as AuthenticatedMedusaRequest;
}
beforeEach(() => {
  for (const key of keys) saved[key] = process.env[key];
  process.env.ECOPOWERTECH_ENV = "sandbox";
  process.env.DATABASE_URL = "postgresql://fixture:fixture@localhost:5499/medusa";
  query.mockReset().mockResolvedValue({ rows: [] });
  jest.mocked(getDbPool).mockReturnValue({ query } as unknown as ReturnType<typeof getDbPool>);
});
afterEach(() => { for (const key of keys) {
  if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
} });

describe("Bank review permissions enforce separate accounting responsibilities", () => {
  it("rejects missing authentication before consulting grants", async () => {
    await expect(reviewAccess({} as AuthenticatedMedusaRequest, "read")).rejects.toMatchObject({ code: "BANKING_AUTH_REQUIRED", status: 401 });
    expect(query).not.toHaveBeenCalled();
  });
  test.each<ReviewCapability>(["read", "review", "close", "manage"])("ordinary staff cannot %s", async capability => {
    await expect(reviewAccess(request(), capability)).rejects.toMatchObject({ code: "BANKING_ACCESS_DENIED", status: 403 });
  });
  it("accounting visibility allows reading without granting review or close", async () => {
    await expect(reviewAccess(request(true), "read")).resolves.toMatchObject({ canReview: false, canClose: false, canManage: false });
    for (const capability of ["review", "close", "manage"] as const) {
      await expect(reviewAccess(request(true), capability)).rejects.toMatchObject({ status: 403 });
    }
  });
  it("explicit reviewer grant allows preparing and reading but not closing or administering", async () => {
    query.mockResolvedValue({ rows: [{ can_review: true, can_close: false }] });
    await expect(reviewAccess(request(), "review")).resolves.toMatchObject({ canReview: true, canClose: false });
    await expect(reviewAccess(request(), "read")).resolves.toBeDefined();
    for (const capability of ["close", "manage"] as const) await expect(reviewAccess(request(), capability)).rejects.toMatchObject({ status: 403 });
    expect(query.mock.calls[0]?.[1]).toEqual(["staff-fixture"]);
  });
  it("closing authority is independent from preparation authority", async () => {
    query.mockResolvedValue({ rows: [{ can_review: false, can_close: true }] });
    await expect(reviewAccess(request(), "close")).resolves.toMatchObject({ canReview: false, canClose: true });
    await expect(reviewAccess(request(), "review")).rejects.toMatchObject({ status: 403 });
  });
  test.each<ReviewCapability>(["read", "review", "close", "manage"])("full admin can %s without a delegated row", async capability => {
    await expect(reviewAccess(request(false, true), capability)).resolves.toMatchObject({ canReview: true, canClose: true, canManage: true });
    expect(query).not.toHaveBeenCalled();
  });
  it("database failure never degrades into staff authorization", async () => {
    query.mockRejectedValue(new Error("fixture storage unavailable"));
    await expect(reviewAccess(request(true), "review")).rejects.toThrow("fixture storage unavailable");
  });
  it("rejects a non-sandbox DB before loading delegated permissions", async () => {
    process.env.DATABASE_URL = "postgresql://fixture:fixture@remote.example:5432/medusa";
    await expect(reviewAccess(request(true), "review")).rejects.toMatchObject({ code: "BANKING_SANDBOX_DATABASE_REQUIRED" });
    expect(query).not.toHaveBeenCalled();
  });
});
