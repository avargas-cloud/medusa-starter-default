/**
 * Commission Requests — reglas puras (commission-requests-20260917).
 * Una solicitud que nunca podría aprobarse no nace; la aprobación es por
 * coincidencia exacta de identidad con los beneficiarios guardados.
 */
import {
  CommissionRequestError,
  matchRequestsToRecipients,
  requestBlocker,
  validateRequestInput,
  type RequestContext,
} from "../../lib/commissions/requests";

const OK_CTX: RequestContext = {
  orderStatus: "completed",
  orderCustomerId: "cus_order",
  identityExists: true,
  hasPendingForIdentity: false,
  isLiveRecipient: false,
};

describe("validateRequestInput", () => {
  it("acepta customer con nota", () => {
    expect(
      validateRequestInput({ customer_id: "cus_1", display_name: " Ana ", note: " ref " })
    ).toEqual({ customerId: "cus_1", qbVendorId: undefined, displayName: "Ana", note: "ref" });
  });

  it("acepta vendor sin nota (note → null)", () => {
    expect(validateRequestInput({ qb_vendor_id: "qbv_1", display_name: "ACME" })).toEqual({
      customerId: undefined,
      qbVendorId: "qbv_1",
      displayName: "ACME",
      note: null,
    });
  });

  it("rechaza sin identidad, con dos identidades, sin nombre y nota larga", () => {
    expect(() => validateRequestInput({ display_name: "x" })).toThrow(CommissionRequestError);
    expect(() =>
      validateRequestInput({ customer_id: "a", qb_vendor_id: "b", display_name: "x" })
    ).toThrow(/ONE beneficiary/);
    expect(() => validateRequestInput({ customer_id: "a", display_name: "  " })).toThrow(
      /display_name/
    );
    expect(() =>
      validateRequestInput({ customer_id: "a", display_name: "x", note: "n".repeat(501) })
    ).toThrow(/too long/);
  });
});

describe("requestBlocker", () => {
  const input = { customerId: "cus_1", displayName: "Ana", note: null };

  it("deja pasar el caso normal", () => {
    expect(requestBlocker(input, OK_CTX)).toBeNull();
  });

  it("orden cancelada → order_not_commissionable (completed/archived pasan)", () => {
    expect(requestBlocker(input, { ...OK_CTX, orderStatus: "canceled" })?.code).toBe(
      "order_not_commissionable"
    );
    expect(requestBlocker(input, { ...OK_CTX, orderStatus: "archived" })).toBeNull();
  });

  it("el cliente de la orden no puede ser beneficiario", () => {
    expect(requestBlocker(input, { ...OK_CTX, orderCustomerId: "cus_1" })?.code).toBe(
      "beneficiary_is_order_customer"
    );
  });

  it("identidad inexistente, pendiente duplicada y beneficiario vivo", () => {
    expect(requestBlocker(input, { ...OK_CTX, identityExists: false })?.code).toBe(
      "identity_not_found"
    );
    expect(requestBlocker(input, { ...OK_CTX, hasPendingForIdentity: true })?.code).toBe(
      "duplicate_pending_request"
    );
    expect(requestBlocker(input, { ...OK_CTX, isLiveRecipient: true })?.code).toBe(
      "already_a_recipient"
    );
  });
});

describe("matchRequestsToRecipients", () => {
  const pending = [
    { id: "r_cus", customer_id: "cus_1", qb_vendor_id: null },
    { id: "r_ven", customer_id: null, qb_vendor_id: "qbv_1" },
    { id: "r_other", customer_id: "cus_9", qb_vendor_id: null },
  ];

  it("aprueba por coincidencia exacta de customer o vendor; el resto sigue pendiente", () => {
    expect(
      matchRequestsToRecipients(pending, [{ customerId: "cus_1" }, { qbVendorId: "qbv_1" }])
    ).toEqual(["r_cus", "r_ven"]);
  });

  it("un customer NO matchea contra un qb_vendor_id con el mismo string", () => {
    expect(matchRequestsToRecipients(pending, [{ qbVendorId: "cus_1" }])).toEqual([]);
  });

  it("sin beneficiarios no aprueba nada", () => {
    expect(matchRequestsToRecipients(pending, [])).toEqual([]);
  });
});
