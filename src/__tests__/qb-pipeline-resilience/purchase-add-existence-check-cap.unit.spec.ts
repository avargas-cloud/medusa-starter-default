// `schedulePurchaseAddExistenceCheck` pasó a devolver un booleano porque su
// llamador NO puede asumir que la fila quedó atendida: si el tope se agota, o
// si otra pasada movió la fila fuera de 'submitted', quien llama tiene que
// seguir por el camino de falla normal. Sin ese contrato, un ADD que agotó el
// tope se quedaría 'submitted' para siempre, sin operación de bridge viva que
// lo destrabe.

const query = jest.fn();
jest.mock("../../api/utils/db-pool", () => ({
  getDbPool: () => ({ query: (...args: unknown[]) => query(...args) }),
}));

import {
  PURCHASE_EXISTENCE_MAX_ATTEMPTS,
  schedulePurchaseAddExistenceCheck,
} from "../../lib/quickbooks/consolidator/purchase-operations";

const baseRow = {
  id: "e2c8571d-face-432f-957e-2cca3b95aaf1",
  order_id: null,
  reference_id: "vb_72e83f93885348c59b099c7c2cf8d9c4",
  reference_type: "vendor_bill",
  step: "vendor_bill_add",
  qb_txn_id: null,
  retry_count: 1,
  payload: {} as Record<string, unknown>,
};

beforeEach(() => jest.clearAllMocks());

describe("schedulePurchaseAddExistenceCheck — tope y contrato de retorno", () => {
  it("arma el check y devuelve true en el primer intento", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });

    const scheduled = await schedulePurchaseAddExistenceCheck(
      { ...baseRow } as never,
      "sesión abortada"
    );

    expect(scheduled).toBe(true);
    const [sql, params] = query.mock.calls[0];
    expect(String(sql)).toMatch(/status\s*=\s*'pending'/);
    expect(String(sql)).toMatch(/status = 'submitted'/);
    // El contador arranca en 1, no en 0: si arrancara en 0 el tope permitiría
    // un intento de más y el bug volvería con otro número.
    expect(params).toContain(1);
  });

  it("incrementa el contador en cada re-armado", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 1 });

    await schedulePurchaseAddExistenceCheck(
      { ...baseRow, payload: { __purchase_add_existence_attempts: 2 } } as never,
      "otra vez"
    );

    expect(query.mock.calls[0][1]).toContain(3);
  });

  it("devuelve false —sin tocar la DB— al agotar el tope", async () => {
    const scheduled = await schedulePurchaseAddExistenceCheck(
      {
        ...baseRow,
        payload: {
          __purchase_add_existence_attempts: PURCHASE_EXISTENCE_MAX_ATTEMPTS,
        },
      } as never,
      "loop"
    );

    expect(scheduled).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("devuelve false si la fila ya no estaba 'submitted' (carrera)", async () => {
    // rowCount 0 = otra pasada la movió entre el poll y este UPDATE. No se
    // re-armó nada, así que decir true dejaría la fila sin dueño.
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    const scheduled = await schedulePurchaseAddExistenceCheck(
      { ...baseRow } as never,
      "carrera"
    );

    expect(scheduled).toBe(false);
    // Y no espeja la fila legacy a 'waiting' sobre un cambio que no ocurrió.
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("no aplica a un step que no es ADD", async () => {
    const scheduled = await schedulePurchaseAddExistenceCheck(
      { ...baseRow, step: "purchase_order_mod" } as never,
      "n/a"
    );

    expect(scheduled).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
