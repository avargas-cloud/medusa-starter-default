/**
 * ReceivePayment SIEMPRE lleva DepositToAccountRef.
 *
 * QuickBooks Desktop no cae en Undeposited Funds cuando el request no trae
 * cuenta: reusa la ÚLTIMA "Deposit To" usada en el formulario. El 2026-09-11
 * el pago #3797 (1D0A48) quedó en `Referral Commission Clearing` porque los
 * ReceivePayment de comisión del día anterior fueron los primeros con cuenta
 * explícita. Este spec afirma el BODY que viaja al bridge, que es lo único que
 * el backend controla.
 */
const bridgeFetch = jest.fn();

jest.mock("../../lib/quickbooks/client/core", () => ({
  DRY_RUN: false,
  bridgeFetch: (...args: unknown[]) => bridgeFetch(...args),
  pollRawOperationResult: jest.fn(),
  pollOperationResult: jest.fn(),
}));

import {
  DEFAULT_RECEIVE_PAYMENT_DEPOSIT_ACCOUNT,
  receivePaymentInQb,
} from "../../lib/quickbooks/client/payments";

type Body = { depositAccount?: string; autoApply?: boolean; memo?: string };

function sentBody(): Body {
  expect(bridgeFetch).toHaveBeenCalledTimes(1);
  const [method, path, body] = bridgeFetch.mock.calls[0] as [string, string, Body];
  expect(method).toBe("POST");
  expect(path).toBe("/api/payments");
  return body;
}

describe("receivePaymentInQb — DepositToAccountRef", () => {
  beforeEach(() => {
    bridgeFetch.mockReset();
    bridgeFetch.mockResolvedValue({ operationId: "op-1" });
  });

  it("el default es Undeposited Funds", () => {
    expect(DEFAULT_RECEIVE_PAYMENT_DEPOSIT_ACCOUNT).toBe("Undeposited Funds");
  });

  it("un pago del POS sin cuenta viaja con Undeposited Funds (el camino de order-flow-core)", async () => {
    const res = await receivePaymentInQb({
      customerId: "80000001-1",
      amount: 219.24,
      date: "2026-09-11",
      paymentMethod: "American Express",
      memo: "Payment 3797 for Order 3406",
      autoApply: false,
    });
    expect(res.success).toBe(true);
    const body = sentBody();
    expect(body.depositAccount).toBe("Undeposited Funds");
    expect(body.autoApply).toBe(false);
    expect(body.memo).toBe("Payment 3797 for Order 3406");
  });

  it("un `depositAccount: undefined` explícito tampoco deja el request sin cuenta", async () => {
    await receivePaymentInQb({
      customerId: "80000001-1",
      amount: 10,
      depositAccount: undefined,
    });
    expect(sentBody().depositAccount).toBe("Undeposited Funds");
  });

  it("un caller que manda su cuenta la conserva (liquidación de comisión → clearing)", async () => {
    await receivePaymentInQb({
      customerId: "80000001-1",
      amount: 82.41,
      depositAccount: "Referral Commission Clearing",
    });
    expect(sentBody().depositAccount).toBe("Referral Commission Clearing");
  });
});
