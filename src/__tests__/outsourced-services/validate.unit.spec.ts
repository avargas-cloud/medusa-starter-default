import {
  looksLikeDuplicate,
  MAX_DESCRIPTION_LENGTH,
  MAX_SERVICE_AMOUNT_CENTS,
  validateService,
  VALIDATION_MESSAGE,
  type ServiceInput,
} from "../../lib/outsourced-services/validate";

const base = (over: Partial<ServiceInput> = {}): ServiceInput => ({
  qbVendorId: "qbvnd_1",
  vendorDisplayName: "Bella Lighting",
  serviceTypeId: "ostp_on_site_installation",
  amountCents: 45000,
  ...over,
});

describe("outsourced services — validate", () => {
  it("acepta una entrada completa", () => {
    expect(validateService(base())).toEqual({ ok: true });
  });

  describe("identidad: SIEMPRE vendor, nunca customer", () => {
    it("rechaza sin vendor", () => {
      expect(validateService(base({ qbVendorId: "" }))).toEqual({
        ok: false,
        reason: "missing_vendor",
      });
    });

    it("rechaza un vendor que es sólo espacios", () => {
      expect(validateService(base({ qbVendorId: "   " }))).toEqual({
        ok: false,
        reason: "missing_vendor",
      });
    });

    it("rechaza sin nombre de vendor: alimenta el memo del bill en QuickBooks", () => {
      expect(validateService(base({ vendorDisplayName: "" }))).toEqual({
        ok: false,
        reason: "missing_vendor_name",
      });
    });
  });

  it("rechaza sin tipo de servicio", () => {
    expect(validateService(base({ serviceTypeId: "" }))).toEqual({
      ok: false,
      reason: "missing_service_type",
    });
  });

  describe("monto: fijo, entero, positivo", () => {
    it.each([0, -1, -45000])("rechaza %p", (amountCents) => {
      expect(validateService(base({ amountCents }))).toEqual({
        ok: false,
        reason: "invalid_amount",
      });
    });

    it("rechaza NaN — es lo que llega si el body no trae un número", () => {
      expect(validateService(base({ amountCents: NaN }))).toEqual({
        ok: false,
        reason: "invalid_amount",
      });
    });

    it("rechaza un decimal: el dinero se lleva en CENTAVOS enteros", () => {
      expect(validateService(base({ amountCents: 450.5 }))).toEqual({
        ok: false,
        reason: "invalid_amount",
      });
    });

    it("acepta el máximo exacto y rechaza uno más", () => {
      expect(validateService(base({ amountCents: MAX_SERVICE_AMOUNT_CENTS }))).toEqual({
        ok: true,
      });
      expect(
        validateService(base({ amountCents: MAX_SERVICE_AMOUNT_CENTS + 1 }))
      ).toEqual({ ok: false, reason: "amount_too_large" });
    });
  });

  it("rechaza una descripción más larga que el tope", () => {
    expect(
      validateService(base({ description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1) }))
    ).toEqual({ ok: false, reason: "description_too_long" });
    expect(
      validateService(base({ description: "x".repeat(MAX_DESCRIPTION_LENGTH) }))
    ).toEqual({ ok: true });
  });

  it("todo motivo de rechazo tiene un mensaje para el operador", () => {
    const reasons = [
      "missing_vendor",
      "missing_vendor_name",
      "missing_service_type",
      "invalid_amount",
      "amount_too_large",
      "description_too_long",
    ] as const;
    for (const r of reasons) {
      expect(VALIDATION_MESSAGE[r]).toBeTruthy();
    }
  });
});

describe("outsourced services — looksLikeDuplicate", () => {
  const existing = [
    { qbVendorId: "v1", serviceTypeId: "t1", amountCents: 45000 },
    { qbVendorId: "v2", serviceTypeId: "t2", amountCents: 9900 },
  ];

  it("marca vendor + tipo + monto idénticos", () => {
    expect(
      looksLikeDuplicate({ qbVendorId: "v1", serviceTypeId: "t1", amountCents: 45000 }, existing)
    ).toBe(true);
  });

  it("NO marca el mismo vendor y tipo con OTRO monto — dos visitas distintas", () => {
    expect(
      looksLikeDuplicate({ qbVendorId: "v1", serviceTypeId: "t1", amountCents: 30000 }, existing)
    ).toBe(false);
  });

  it("NO marca el mismo monto de otro vendor", () => {
    expect(
      looksLikeDuplicate({ qbVendorId: "v9", serviceTypeId: "t1", amountCents: 45000 }, existing)
    ).toBe(false);
  });

  it("no marca nada contra una lista vacía", () => {
    expect(
      looksLikeDuplicate({ qbVendorId: "v1", serviceTypeId: "t1", amountCents: 45000 }, [])
    ).toBe(false);
  });
});
