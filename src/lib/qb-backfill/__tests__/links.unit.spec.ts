import { linkedTxnIdsOfType, matchPoLineForVariant, type OpenPoLine } from "../links";
import type { QbLinkedTxn } from "../types";

function linked(overrides: Partial<QbLinkedTxn> = {}): QbLinkedTxn {
  return { txn_id: "T1", txn_type: "PurchaseOrder", txn_date: "2026-08-01", amount_cents: 100, ref_number: null, ...overrides };
}

describe("qb-backfill/links", () => {
  describe("linkedTxnIdsOfType", () => {
    it("filtra por txn_type y devuelve sólo los TxnID", () => {
      const linked_txns = [
        linked({ txn_id: "PO1", txn_type: "PurchaseOrder" }),
        linked({ txn_id: "B1", txn_type: "Bill" }),
        linked({ txn_id: "PO2", txn_type: "PurchaseOrder" }),
      ];
      expect(linkedTxnIdsOfType(linked_txns, "PurchaseOrder")).toEqual(["PO1", "PO2"]);
    });
    it("lista vacía si no hay ningún match", () => {
      expect(linkedTxnIdsOfType([linked({ txn_type: "Bill" })], "PurchaseOrder")).toEqual([]);
    });
  });

  describe("matchPoLineForVariant", () => {
    const lines: OpenPoLine[] = [
      { id: "L1", product_variant_id: "v1", qty_ordered: 10, already_matched: 0 },
      { id: "L2", product_variant_id: "v2", qty_ordered: 5, already_matched: 0 },
      { id: "L3", product_variant_id: "v1", qty_ordered: 3, already_matched: 0 },
    ];

    it("matchea la primera línea abierta de la variante pedida", () => {
      expect(matchPoLineForVariant(lines, "v1", 4)?.id).toBe("L1");
    });
    it("línea con capacidad agotada (already_matched = qty_ordered) se saltea a favor de la siguiente", () => {
      const withUsed = lines.map((l) => (l.id === "L1" ? { ...l, already_matched: 10 } : l));
      expect(matchPoLineForVariant(withUsed, "v1", 2)?.id).toBe("L3");
    });
    it("sin variante que matchee → null (negativo)", () => {
      expect(matchPoLineForVariant(lines, "v9", 1)).toBeNull();
    });
    it("variantId null → null sin recorrer nada", () => {
      expect(matchPoLineForVariant(lines, null, 1)).toBeNull();
    });
    it("qtyNeeded <= 0 → null (no matchea una cantidad no positiva)", () => {
      expect(matchPoLineForVariant(lines, "v1", 0)).toBeNull();
    });
    it("permite match PARCIAL: no exige que la línea cubra el total pedido", () => {
      // L2 sólo tiene 5 de capacidad, se pide 50 — igual matchea (el caller decide si bloquea por remanente)
      expect(matchPoLineForVariant(lines, "v2", 50)?.id).toBe("L2");
    });
  });
});
