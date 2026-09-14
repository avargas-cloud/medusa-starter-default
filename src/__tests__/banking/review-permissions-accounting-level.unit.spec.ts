import { getDbPool } from "../../api/utils/db-pool";
import {
  listReviewPermissions,
  saveReviewPermission,
} from "../../lib/banking/review-permissions";

jest.mock("../../api/utils/db-pool", () => ({ getDbPool: jest.fn() }));
jest.mock("../../modules/pos-user", () => ({ POS_USER_MODULE: "pos_user" }));
// El comando idempotente se prueba aparte; acá sólo importa QUÉ escribe el callback.
jest.mock("../../lib/banking/review-common", () => ({
  runReviewCommand: (_command: unknown, callback: (client: unknown) => Promise<unknown>) =>
    callback({ query }),
  appendReviewEvent: jest.fn(),
  reviewCapacity: jest.fn(),
}));

const query = jest.fn();
const saved: Record<string, string | undefined> = {};
const keys = ["ECOPOWERTECH_ENV", "DATABASE_URL", "POS_OWNER_EMAILS"] as const;
beforeEach(() => {
  for (const key of keys) saved[key] = process.env[key];
  process.env.ECOPOWERTECH_ENV = "sandbox";
  process.env.DATABASE_URL = "postgresql://fixture:fixture@localhost:5499/medusa";
  process.env.POS_OWNER_EMAILS = "Owner@Example.test";
  query.mockReset().mockResolvedValue({ rows: [] });
  jest.mocked(getDbPool).mockReturnValue({ query } as unknown as ReturnType<typeof getDbPool>);
});
afterEach(() => { for (const key of keys) {
  if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
} });

/**
 * 2026-09-14: los granos de Banking (review/close/post) sólo tienen sentido sobre
 * un usuario con nivel Accounting — `reviewAccess` los ignora sin ese nivel. La
 * lista y el alta tienen que decir lo mismo que el guard, o el operador otorga
 * permisos inertes a cajeros (pasó en prod el primer día de Banking).
 */
describe("Banking permissions are limited to Accounting-level users", () => {
  it("lists only users with a live accounting grant and never the owner", async () => {
    await listReviewPermissions();
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("pos_accounting_grant");
    expect(sql).toContain("revoked_at IS NULL");
    expect(sql).toContain("NOT (lower(u.email)=ANY($1::text[]))");
    expect(params).toEqual([["owner@example.test"]]);
  });
  it("refuses to grant grains to a user without Accounting access, before any write", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "user_cashier", accounting: false }] });
    await expect(
      saveReviewPermission("owner", "key-1", { user_id: "user_cashier", can_review: true, can_close: false })
    ).rejects.toMatchObject({ code: "BANKING_ACCOUNTING_LEVEL_REQUIRED", status: 409 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO bank_review_permission"))).toBe(false);
  });
  it("still writes the grains for an Accounting-level user", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: "user_acct", accounting: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "brp_1", user_id: "user_acct", can_review: true, can_close: false, can_post: false }] });
    const result = await saveReviewPermission("owner", "key-2", { user_id: "user_acct", can_review: true, can_close: false });
    expect(result.permission?.user_id).toBe("user_acct");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO bank_review_permission"))).toBe(true);
  });
});
