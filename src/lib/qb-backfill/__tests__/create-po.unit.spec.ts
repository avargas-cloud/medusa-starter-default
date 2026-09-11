import { decidePoCreation, derivePoStatus, businessInstant, isEmptyPoLine } from "../create-po";
import type { QbPurchaseOrder, QbPurchaseOrderLine } from "../types";

function line(overrides: Partial<QbPurchaseOrderLine> = {}): QbPurchaseOrderLine {
  return {
    txn_line_id: "L1",
    item_ref: { list_id: "i1", full_name: "ITEM1" },
    manufacturer_part_number: null,
    description: "desc",
    quantity: 10,
    rate_cents: 100,
    amount_cents: 1000,
    received_quantity: 0,
    is_manually_closed: false,
    ...overrides,
  };
}

function po(overrides: Partial<QbPurchaseOrder> = {}): QbPurchaseOrder {
  return {
    txn_id: "TXN1",
    edit_sequence: "1",
    txn_number: "1001",
    ref_number: "REF1",
    vendor_ref: { list_id: "v1", full_name: "VENDOR1" },
    txn_date: "2026-05-01",
    due_date: null,
    expected_date: null,
    total_amount_cents: 1000,
    is_manually_closed: false,
    is_fully_received: false,
    memo: null,
    lines: [line()],
    linked_txns: [],
    ...overrides,
  };
}

describe("qb-backfill/create-po", () => {
  describe("decidePoCreation", () => {
    it("ya conocido → skip 'already'", () => {
      const d = decidePoCreation(po(), new Set(["TXN1"]));
      expect(d).toEqual({ create: false, reason: "already" });
    });
    it("2025, fully_received → skip 'closed_2025'", () => {
      const d = decidePoCreation(po({ txn_date: "2025-06-01", is_fully_received: true }), new Set());
      expect(d).toEqual({ create: false, reason: "closed_2025" });
    });
    it("2025, manually_closed → skip 'closed_2025'", () => {
      const d = decidePoCreation(po({ txn_date: "2025-12-30", is_manually_closed: true }), new Set());
      expect(d).toEqual({ create: false, reason: "closed_2025" });
    });
    it("2025 ABIERTO (ninguna bandera) → create (negativo: no todo 2025 se saltea)", () => {
      const d = decidePoCreation(po({ txn_date: "2025-03-01" }), new Set());
      expect(d).toEqual({ create: true, reason: "create" });
    });
    it("2026 aunque esté fully_received → create (la regla del cierre es SOLO 2025)", () => {
      const d = decidePoCreation(po({ txn_date: "2026-03-01", is_fully_received: true }), new Set());
      expect(d).toEqual({ create: true, reason: "create" });
    });
  });

  describe("derivePoStatus", () => {
    it("fully_received → received", () => {
      expect(derivePoStatus(po({ is_fully_received: true }))).toBe("received");
    });
    it("alguna línea con received_quantity>0 y no fully → partially_received", () => {
      expect(derivePoStatus(po({ lines: [line({ received_quantity: 3 })] }))).toBe("partially_received");
    });
    it("manually_closed sin recibos → closed", () => {
      expect(derivePoStatus(po({ is_manually_closed: true }))).toBe("closed");
    });
    it("nada de lo anterior → submitted", () => {
      expect(derivePoStatus(po())).toBe("submitted");
    });
  });

  describe("businessInstant", () => {
    it("mediodía ET (16:00 UTC) del día del documento", () => {
      expect(businessInstant("2026-05-01")).toBe("2026-05-01T16:00:00.000Z");
    });
  });
});

describe("isEmptyPoLine (líneas de texto de QB)", () => {
  const base = { txn_line_id: "L1", item_ref: null, manufacturer_part_number: null, description: "Order # 111-5890044", quantity: 0, rate_cents: 0, amount_cents: 0, received_quantity: 0, is_manually_closed: false };
  it("una línea sin ítem, sin cantidad y sin importe se salta", () => {
    expect(isEmptyPoLine(base)).toBe(true);
  });
  it("una línea sin ítem pero con importe NO se salta (bloquea después)", () => {
    expect(isEmptyPoLine({ ...base, amount_cents: 5000 })).toBe(false);
  });
  it("una línea con ítem nunca es vacía", () => {
    expect(isEmptyPoLine({ ...base, item_ref: { list_id: "800001", full_name: "X" } })).toBe(false);
  });
});
