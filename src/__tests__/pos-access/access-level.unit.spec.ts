/**
 * Tabla de decisión de `resolveAccessLevel`.
 *
 * La regla que murió el 2026-09-10 —"usuario de Medusa ausente de `pos_user`
 * ⇒ puede TODO"— se prueba acá al revés: ausente de `pos_user` da `canAdmin`
 * (confirmar con la palabra `confirm`) y NADA de contabilidad.
 */
import type { AuthenticatedMedusaRequest } from "@medusajs/framework/http";

import { getDbPool } from "../../api/utils/db-pool";
import {
  assertAccounting,
  assertAdmin,
  assertOwner,
  deriveAccess,
  isOwnerEmail,
  resolveAccessByUserId,
  resolveAccessLevel,
} from "../../lib/pos/access-level";

jest.mock("../../api/utils/db-pool", () => ({ getDbPool: jest.fn() }));

const query = jest.fn();
const savedOwners = process.env.POS_OWNER_EMAILS;

type Facts = { inPosUser?: boolean; posIsAdmin?: boolean; hasGrant?: boolean };

function facts({ inPosUser = false, posIsAdmin = false, hasGrant = false }: Facts) {
  return {
    rows: [
      { in_pos_user: inPosUser, pos_is_admin: posIsAdmin, has_grant: hasGrant },
    ],
  };
}

function request(email = "staff@example.test"): AuthenticatedMedusaRequest {
  return {
    auth_context: { actor_id: "user_fixture" },
    scope: {
      resolve: () => ({ retrieveUser: async () => ({ email }) }),
    },
  } as unknown as AuthenticatedMedusaRequest;
}

beforeEach(() => {
  query.mockReset().mockResolvedValue(facts({}));
  jest
    .mocked(getDbPool)
    .mockReturnValue({ query } as unknown as ReturnType<typeof getDbPool>);
  delete process.env.POS_OWNER_EMAILS;
});
afterEach(() => {
  if (savedOwners === undefined) delete process.env.POS_OWNER_EMAILS;
  else process.env.POS_OWNER_EMAILS = savedOwners;
});

describe("owner sale de POS_OWNER_EMAILS y falla cerrado", () => {
  it("sin la env var NADIE es owner", async () => {
    await expect(resolveAccessLevel(request())).resolves.toMatchObject({
      isOwner: false,
      level: "admin",
    });
    expect(isOwnerEmail("staff@example.test")).toBe(false);
  });

  it("una env vacía tampoco otorga owner", async () => {
    process.env.POS_OWNER_EMAILS = "   ,  ";
    await expect(resolveAccessLevel(request())).resolves.toMatchObject({
      isOwner: false,
    });
  });

  it("compara case-insensitive y con trim", async () => {
    process.env.POS_OWNER_EMAILS = "  Boss@Example.TEST , otro@example.test ";
    await expect(resolveAccessLevel(request("BOSS@example.test"))).resolves.toMatchObject(
      { isOwner: true, level: "owner", canAdmin: true, canAccounting: true }
    );
  });

  it("el owner conserva contabilidad aunque no tenga grant", async () => {
    process.env.POS_OWNER_EMAILS = "boss@example.test";
    query.mockResolvedValue(facts({ inPosUser: true, hasGrant: false }));
    await expect(resolveAccessLevel(request("boss@example.test"))).resolves.toMatchObject(
      { canAccounting: true, canAdmin: true, level: "owner" }
    );
  });
});

describe("el grant vivo es la única fuente de Accounting", () => {
  it("un grant activo da accounting", async () => {
    query.mockResolvedValue(facts({ inPosUser: true, hasGrant: true }));
    await expect(resolveAccessLevel(request())).resolves.toMatchObject({
      canAccounting: true,
      canAdmin: false,
      level: "accounting",
    });
  });

  it("un grant revocado (ausente del EXISTS) no da nada", async () => {
    query.mockResolvedValue(facts({ inPosUser: true, hasGrant: false }));
    await expect(resolveAccessLevel(request())).resolves.toMatchObject({
      canAccounting: false,
      level: "cashier",
    });
  });

  it("la consulta bindea el user_id y el email normalizado", async () => {
    await resolveAccessLevel(request("Staff@Example.TEST"));
    expect(query.mock.calls[0]?.[1]).toEqual([
      "user_fixture",
      "staff@example.test",
    ]);
  });
});

describe("admin y accounting son independientes", () => {
  it("fuera de pos_user ⇒ admin, sin contabilidad", () => {
    expect(deriveAccess({ isOwner: false, inPosUser: false, posIsAdmin: false, hasActiveGrant: false }))
      .toEqual({ level: "admin", canAdmin: true, canAccounting: false });
  });

  it("pos_user.is_admin ⇒ admin", () => {
    expect(deriveAccess({ isOwner: false, inPosUser: true, posIsAdmin: true, hasActiveGrant: false }))
      .toEqual({ level: "admin", canAdmin: true, canAccounting: false });
  });

  it("accounting NO implica admin", () => {
    expect(deriveAccess({ isOwner: false, inPosUser: true, posIsAdmin: false, hasActiveGrant: true }))
      .toEqual({ level: "accounting", canAdmin: false, canAccounting: true });
  });

  it("cajero puro", () => {
    expect(deriveAccess({ isOwner: false, inPosUser: true, posIsAdmin: false, hasActiveGrant: false }))
      .toEqual({ level: "cashier", canAdmin: false, canAccounting: false });
  });

  it("el label más alto gana pero los flags mandan", () => {
    expect(deriveAccess({ isOwner: false, inPosUser: true, posIsAdmin: true, hasActiveGrant: true }))
      .toEqual({ level: "accounting", canAdmin: true, canAccounting: true });
  });
});

describe("los assert* rechazan con su código", () => {
  it("sin actor autenticado es 401 y no toca la base", async () => {
    await expect(
      resolveAccessLevel({} as AuthenticatedMedusaRequest)
    ).rejects.toMatchObject({ code: "POS_AUTH_REQUIRED", status: 401 });
    expect(query).not.toHaveBeenCalled();
  });

  it("ACCOUNTING_ACCESS_REQUIRED para un cajero", async () => {
    query.mockResolvedValue(facts({ inPosUser: true }));
    await expect(assertAccounting(request())).rejects.toMatchObject({
      code: "ACCOUNTING_ACCESS_REQUIRED",
      status: 403,
    });
  });

  it("ADMIN_REQUIRED para un cajero", async () => {
    query.mockResolvedValue(facts({ inPosUser: true }));
    await expect(assertAdmin(request())).rejects.toMatchObject({
      code: "ADMIN_REQUIRED",
      status: 403,
    });
  });

  it("OWNER_REQUIRED para cualquiera que no esté en la env", async () => {
    query.mockResolvedValue(facts({ hasGrant: true }));
    await expect(assertOwner(request())).rejects.toMatchObject({
      code: "OWNER_REQUIRED",
      status: 403,
    });
  });

  it("resuelve una sola vez por request", async () => {
    const req = request();
    await resolveAccessLevel(req);
    await assertAdmin(req);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("resolveAccessByUserId (el camino del guard de PIN)", () => {
  it("devuelve null cuando el usuario no existe", async () => {
    query.mockResolvedValue({ rows: [] });
    await expect(resolveAccessByUserId("user_ausente")).resolves.toBeNull();
  });

  it("aplica la misma tabla de decisión", async () => {
    process.env.POS_OWNER_EMAILS = "boss@example.test";
    query.mockResolvedValue({
      rows: [
        {
          email: "boss@example.test",
          in_pos_user: true,
          pos_is_admin: false,
          has_grant: false,
        },
      ],
    });
    await expect(resolveAccessByUserId("user_boss")).resolves.toMatchObject({
      isOwner: true,
      canAdmin: true,
      canAccounting: true,
      level: "owner",
    });
    expect(query.mock.calls[0]?.[1]).toEqual(["user_boss"]);
  });
});
