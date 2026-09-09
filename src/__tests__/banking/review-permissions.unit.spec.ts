import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";
import { getDbPool } from "../../api/utils/db-pool";
import { reviewAccess, type ReviewCapability } from "../../lib/banking/review-permissions";

jest.mock("../../api/utils/db-pool", () => ({ getDbPool: jest.fn() }));
jest.mock("../../modules/pos-user", () => ({ POS_USER_MODULE: "pos_user" }));

const query = jest.fn();
const saved: Record<string, string | undefined> = {};
const keys = ["ECOPOWERTECH_ENV", "DATABASE_URL", "POS_OWNER_EMAILS"] as const;

/**
 * REGLA NUEVA (2026-09-10): `accounting` ahora significa "tiene grant vivo en
 * `pos_accounting_grant`", y `admin` (ausente de `pos_user`) ya NO otorga nada
 * — esa era exactamente la regla que se eliminó, así que los casos que la
 * afirmaban se reescribieron para exigir lo contrario.
 *
 * La primera consulta que dispara `reviewAccess` es la de la identidad
 * (`access-level.ts`); la segunda, si llega, es la de `bank_review_permission`.
 */
function request(accounting = false, admin = false): AuthenticatedMedusaRequest {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("bank_review_permission")) return grains;
    return { rows: [{ in_pos_user: !admin, pos_is_admin: false, has_grant: accounting }] };
  });
  return { auth_context: { actor_id: "staff-fixture" }, scope: {
    resolve: () => ({ retrieveUser: async () => ({ email: "staff@example.test" }) }),
  } } as unknown as AuthenticatedMedusaRequest;
}
let grains: { rows: Array<Record<string, boolean>> } = { rows: [] };
function grainRows(rows: Array<Record<string, boolean>>) { grains = { rows }; }
beforeEach(() => {
  for (const key of keys) saved[key] = process.env[key];
  process.env.ECOPOWERTECH_ENV = "sandbox";
  process.env.DATABASE_URL = "postgresql://fixture:fixture@localhost:5499/medusa";
  query.mockReset().mockResolvedValue({ rows: [] });
  grainRows([]);
  process.env.POS_OWNER_EMAILS = "";
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
  it("un grant de Accounting SIN Admin lee, y review/close/post salen de sus granos — nunca manage", async () => {
    // Antes canManage = canAccounting: todo grant de Accounting era manage completo y los granos quedaban inertes.
    await expect(reviewAccess(request(true), "read")).resolves.toMatchObject({ canManage: false });
    await expect(reviewAccess(request(true), "manage")).rejects.toMatchObject({ code: "BANKING_ACCESS_DENIED", status: 403 });
    await expect(reviewAccess(request(true), "review")).rejects.toMatchObject({ status: 403 });
    grainRows([{ can_review: true, can_close: false, can_post: false }]);
    await expect(reviewAccess(request(true), "review")).resolves.toMatchObject({ canManage: false, canReview: true, canClose: false });
    await expect(reviewAccess(request(true), "close")).rejects.toMatchObject({ status: 403 });
  });
  test.each<ReviewCapability>(["read", "review", "close", "manage"])("Accounting + Admin habilita %s (manage)", async capability => {
    await expect(reviewAccess(request(true, true), capability)).resolves.toMatchObject({ canManage: true });
  });
  it("REGLA NUEVA: un grano de bank_review_permission SIN Accounting ya no alcanza", async () => {
    // Antes esto pasaba: `can_review=true` autorizaba a alguien sin contabilidad.
    grainRows([{ can_review: true, can_close: false, can_post: false }]);
    for (const capability of ["read", "review", "close", "manage"] as const) {
      await expect(reviewAccess(request(), capability)).rejects.toMatchObject({ status: 403 });
    }
  });
  test.each<ReviewCapability>(["read", "review", "close", "manage"])(
    "REGLA NUEVA: ausente de pos_user (el viejo \"full admin\") ya no puede %s sin grant",
    async capability => {
      await expect(reviewAccess(request(false, true), capability)).rejects.toMatchObject({ status: 403 });
    });
  test.each<ReviewCapability>(["read", "review", "close", "manage"])("el owner puede %s", async capability => {
    process.env.POS_OWNER_EMAILS = "staff@example.test";
    await expect(reviewAccess(request(false, true), capability)).resolves.toMatchObject({ canManage: true });
  });
  it("REGLA NUEVA: una DB no-sandbox nunca termina autorizando", async () => {
    // Este caso antes llegaba a `requireBankingEnabled()` y fallaba con
    // BANKING_SANDBOX_DATABASE_REQUIRED. Hoy la puerta de Accounting corre
    // primero: sin grant se rechaza ahí, y CON grant ya no se consultan granos,
    // así que ese chequeo dejó de correr en este camino. Lo que se afirma —y es
    // lo que importa— es que en ningún caso el resultado es "permitido".
    process.env.DATABASE_URL = "postgresql://fixture:fixture@remote.example:5432/medusa";
    await expect(reviewAccess(request(), "review")).rejects.toMatchObject({ status: 403 });
  });
  it("database failure never degrades into staff authorization", async () => {
    const req = request(true);
    query.mockRejectedValue(new Error("fixture storage unavailable"));
    await expect(reviewAccess(req, "review")).rejects.toThrow("fixture storage unavailable");
  });
});
