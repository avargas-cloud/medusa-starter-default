/**
 * `PATCH /admin/pos-users/:id` — la ruta que hasta 2026-09-10 escribía
 * `can_view_accounting` SIN ninguna autorización.
 *
 * Ahora: owner obligatorio (administrar staff es Admin Tools) y la clave vieja
 * se rechaza con 400 en vez de escribirse en silencio.
 */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getDbPool } from "../../api/utils/db-pool";
import { PATCH } from "../../api/admin/pos-users/[id]/route";

jest.mock("../../api/utils/db-pool", () => ({ getDbPool: jest.fn() }));

const query = jest.fn();
const updatePosUsers = jest.fn();
const savedOwners = process.env.POS_OWNER_EMAILS;

function response() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as MedusaResponse & { statusCode: number; body: unknown };
}

function request(
  body: Record<string, unknown>,
  email = "boss@example.test"
): AuthenticatedMedusaRequest<Record<string, unknown>> {
  return {
    auth_context: { actor_id: "user_fixture" },
    params: { id: "posu_1" },
    body,
    scope: {
      resolve: (key: string) =>
        key === "user"
          ? { retrieveUser: async () => ({ email }) }
          : { updatePosUsers, deletePosUsers: jest.fn() },
    },
  } as unknown as AuthenticatedMedusaRequest<Record<string, unknown>>;
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({
    rows: [{ in_pos_user: false, pos_is_admin: false, has_grant: false }],
  });
  updatePosUsers.mockReset().mockResolvedValue([{ id: "posu_1" }]);
  jest
    .mocked(getDbPool)
    .mockReturnValue({ query } as unknown as ReturnType<typeof getDbPool>);
  process.env.POS_OWNER_EMAILS = "boss@example.test";
});
afterEach(() => {
  if (savedOwners === undefined) delete process.env.POS_OWNER_EMAILS;
  else process.env.POS_OWNER_EMAILS = savedOwners;
});

describe("PATCH /admin/pos-users/:id", () => {
  it("rechaza can_view_accounting con 400 y sin tocar el registro", async () => {
    const res = response();
    await PATCH(request({ can_view_accounting: true }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: "ACCOUNTING_GRANT_VIA_OWNER_ONLY" });
    expect(updatePosUsers).not.toHaveBeenCalled();
  });

  it("lo rechaza también cuando viene en false (borrar el permiso tampoco va por acá)", async () => {
    const res = response();
    await PATCH(request({ can_view_accounting: false, first_name: "Ana" }), res);
    expect(res.statusCode).toBe(400);
    expect(updatePosUsers).not.toHaveBeenCalled();
  });

  it("un admin que NO es owner recibe ADMIN_REQUIRED", async () => {
    const res = response();
    await PATCH(request({ first_name: "Ana" }, "staff@example.test"), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: "OWNER_REQUIRED" });
    expect(updatePosUsers).not.toHaveBeenCalled();
  });

  it("el owner sí puede renombrar", async () => {
    const res = response();
    await PATCH(request({ first_name: "Ana" }), res);
    expect(res.statusCode).toBe(200);
    expect(updatePosUsers).toHaveBeenCalledWith([
      { id: "posu_1", first_name: "Ana" },
    ]);
  });

  it("is_admin se escribe con SQL parametrizado, nunca interpolado", async () => {
    const res = response();
    query.mockResolvedValueOnce({
      rows: [{ in_pos_user: false, pos_is_admin: false, has_grant: false }],
    });
    query.mockResolvedValueOnce({ rows: [{ id: "posu_1", is_admin: true }] });
    await PATCH(request({ is_admin: true }), res);
    expect(res.statusCode).toBe(200);
    const write = query.mock.calls[1];
    expect(write?.[0]).toContain("UPDATE pos_user SET is_admin=$2");
    expect(write?.[1]).toEqual(["posu_1", true]);
  });
});
