/**
 * Confirmación de admin en el guard de PIN.
 *
 * `confirm` NO es un bypass: es una credencial distinta para una identidad ya
 * probada por el JWT. Para un cajero es un PIN equivocado y punto — 403 y suma
 * al throttle, que es lo único que separa "hay que saber el PIN" de "hay que
 * adivinarlo".
 */
import { guardSupervisorPin } from "../../lib/pos/supervisor-pin-guard";
import { resolveAccessByUserId } from "../../lib/pos/access-level";
import type { PinConn } from "../../lib/pos/verify-supervisor-pin";

jest.mock("../../lib/pos/access-level", () => ({
  resolveAccessByUserId: jest.fn(),
}));

const raw = jest.fn();
const cacheGet = jest.fn();
const cacheSet = jest.fn();
const cacheInvalidate = jest.fn();

const scope = {
  resolve: () => ({
    get: cacheGet,
    set: cacheSet,
    invalidate: cacheInvalidate,
  }),
};
const db = { raw } as unknown as PinConn;

function identity(canAdmin: boolean, isOwner = false) {
  return {
    userId: "user_fixture",
    email: "someone@example.test",
    level: canAdmin ? "admin" : "cashier",
    isOwner,
    canAdmin,
    canAccounting: isOwner,
    inPosUser: !canAdmin,
  };
}

beforeEach(() => {
  raw.mockReset().mockResolvedValue({
    rows: [{ metadata: { pos_supervisor_pin: "4321" } }],
  });
  cacheGet.mockReset().mockResolvedValue(0);
  cacheSet.mockReset().mockResolvedValue(undefined);
  cacheInvalidate.mockReset().mockResolvedValue(undefined);
  jest.mocked(resolveAccessByUserId).mockReset();
});

const input = (pin: unknown) => ({
  scope,
  db,
  pin,
  actorId: "user_fixture",
});

describe("la palabra confirm", () => {
  it("un admin autoriza escribiendo confirm", async () => {
    jest.mocked(resolveAccessByUserId).mockResolvedValue(identity(true));
    await expect(guardSupervisorPin(input("confirm"))).resolves.toEqual({
      ok: true,
      via: "admin-confirmation",
    });
    // Nunca se consultó el PIN guardado: no hace falta conocerlo.
    expect(raw).not.toHaveBeenCalled();
  });

  it("el owner también", async () => {
    jest.mocked(resolveAccessByUserId).mockResolvedValue(identity(true, true));
    await expect(guardSupervisorPin(input("confirm"))).resolves.toMatchObject({
      ok: true,
      via: "admin-confirmation",
    });
  });

  it("para un cajero es un PIN equivocado: 403 y suma al throttle", async () => {
    jest.mocked(resolveAccessByUserId).mockResolvedValue(identity(false));
    await expect(guardSupervisorPin(input("confirm"))).resolves.toMatchObject({
      ok: false,
      reason: "invalid",
      attemptsLeft: 7,
    });
    expect(cacheSet).toHaveBeenCalled();
  });

  it("es case-sensitive: Confirm no autoriza a nadie", async () => {
    jest.mocked(resolveAccessByUserId).mockResolvedValue(identity(true));
    await expect(guardSupervisorPin(input("Confirm"))).resolves.toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("si la identidad no se puede resolver, no autoriza (fail-closed)", async () => {
    jest
      .mocked(resolveAccessByUserId)
      .mockRejectedValue(new Error("db caída"));
    await expect(guardSupervisorPin(input("confirm"))).resolves.toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("el PIN real sigue siendo el PIN real", () => {
  it("un admin con el PIN equivocado es rechazado igual", async () => {
    jest.mocked(resolveAccessByUserId).mockResolvedValue(identity(true));
    await expect(guardSupervisorPin(input("0000"))).resolves.toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("el PIN correcto autoriza a cualquiera y queda marcado via pin", async () => {
    jest.mocked(resolveAccessByUserId).mockResolvedValue(identity(false));
    await expect(guardSupervisorPin(input("4321"))).resolves.toEqual({
      ok: true,
      via: "pin",
    });
  });

  it("un usuario bloqueado se rechaza ANTES de mirar la credencial", async () => {
    cacheGet.mockResolvedValue(8);
    jest.mocked(resolveAccessByUserId).mockResolvedValue(identity(true));
    await expect(guardSupervisorPin(input("confirm"))).resolves.toMatchObject({
      ok: false,
      reason: "locked",
    });
    expect(resolveAccessByUserId).not.toHaveBeenCalled();
  });
});
