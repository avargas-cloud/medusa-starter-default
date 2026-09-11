import {
  monthlyWindows,
  buildPurchaseOrderQbxml,
  buildBillPaymentCheckQbxml,
  buildBillByTxnIdsQbxml,
  buildPurchaseOrderByTxnIdsQbxml,
  buildItemReceiptByTxnIdsQbxml,
} from "../qb-queries";

describe("qb-backfill/qb-queries", () => {
  describe("monthlyWindows", () => {
    it("una sola ventana cuando from/to caen en el mismo mes", () => {
      const w = [...monthlyWindows("2026-09-01", "2026-09-11")];
      expect(w).toEqual([{ from: "2026-09-01", to: "2026-09-11" }]);
    });
    it("parte por mes calendario, no por 30 días fijos", () => {
      const w = [...monthlyWindows("2026-01-15", "2026-03-05")];
      expect(w).toEqual([
        { from: "2026-01-15", to: "2026-01-31" },
        { from: "2026-02-01", to: "2026-02-28" },
        { from: "2026-03-01", to: "2026-03-05" },
      ]);
    });
    it("cubre un rango de casi 2 años sin huecos ni solapes (2025-01-01..2026-09-11)", () => {
      const w = [...monthlyWindows("2025-01-01", "2026-09-11")];
      expect(w.length).toBe(21); // 12 meses de 2025 + 9 de 2026
      expect(w[0]).toEqual({ from: "2025-01-01", to: "2025-01-31" });
      expect(w[w.length - 1]).toEqual({ from: "2026-09-01", to: "2026-09-11" });
      for (let i = 1; i < w.length; i++) {
        const prevTo = new Date(`${w[i - 1]!.to}T00:00:00Z`);
        const curFrom = new Date(`${w[i]!.from}T00:00:00Z`);
        expect(curFrom.getTime() - prevTo.getTime()).toBe(24 * 60 * 60 * 1000); // exactamente 1 día después
      }
    });
    it("rechaza rango invertido", () => {
      expect(() => [...monthlyWindows("2026-02-01", "2026-01-01")]).toThrow();
    });
  });

  describe("builders", () => {
    it("PurchaseOrderQueryRq: TxnDateRangeFilter antes de los flags Include*", () => {
      const xml = buildPurchaseOrderQbxml("2026-01-01", "2026-01-31");
      const iDate = xml.indexOf("TxnDateRangeFilter");
      const iInclude = xml.indexOf("IncludeLineItems");
      expect(iDate).toBeGreaterThan(-1);
      expect(iInclude).toBeGreaterThan(iDate);
      expect(xml).toContain("<IncludeLinkedTxns>true</IncludeLinkedTxns>");
    });
    it("BillPaymentCheckQueryRq: NUNCA IncludeLinkedTxns (0x80040400 sondeado)", () => {
      const xml = buildBillPaymentCheckQbxml("2026-01-01", "2026-01-31");
      expect(xml).not.toContain("IncludeLinkedTxns");
      expect(xml).toContain("<IncludeLineItems>true</IncludeLineItems>");
    });
    it("envelope completo con onError=stopOnError", () => {
      const xml = buildPurchaseOrderQbxml("2026-01-01", "2026-01-31");
      expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
      expect(xml).toContain('<?qbxml version="10.0"?>');
      expect(xml).toContain('onError="stopOnError"');
    });
    it("fecha inválida lanza", () => {
      expect(() => buildPurchaseOrderQbxml("2026/01/01", "2026-01-31")).toThrow();
    });
  });

  describe("builders by-TxnID (follow-links)", () => {
    it("buildBillByTxnIdsQbxml: un <TxnID> por id, sin TxnDateRangeFilter", () => {
      const xml = buildBillByTxnIdsQbxml(["T1", "T2"]);
      expect(xml).toContain("<TxnID>T1</TxnID>");
      expect(xml).toContain("<TxnID>T2</TxnID>");
      expect(xml).not.toContain("TxnDateRangeFilter");
      expect(xml).toContain("<IncludeLinkedTxns>true</IncludeLinkedTxns>");
    });
    it("buildBillByTxnIdsQbxml: lista vacía lanza", () => {
      expect(() => buildBillByTxnIdsQbxml([])).toThrow();
    });
    it("buildPurchaseOrderByTxnIdsQbxml: mismo patrón, PurchaseOrderQueryRq", () => {
      const xml = buildPurchaseOrderByTxnIdsQbxml(["T1", "T2"]);
      expect(xml).toContain("<PurchaseOrderQueryRq");
      expect(xml).toContain("<TxnID>T1</TxnID>");
      expect(xml).toContain("<TxnID>T2</TxnID>");
      expect(xml).not.toContain("TxnDateRangeFilter");
    });
    it("buildPurchaseOrderByTxnIdsQbxml: lista vacía lanza", () => {
      expect(() => buildPurchaseOrderByTxnIdsQbxml([])).toThrow();
    });
    it("buildItemReceiptByTxnIdsQbxml: mismo patrón, ItemReceiptQueryRq", () => {
      const xml = buildItemReceiptByTxnIdsQbxml(["T1"]);
      expect(xml).toContain("<ItemReceiptQueryRq");
      expect(xml).toContain("<TxnID>T1</TxnID>");
      expect(xml).not.toContain("TxnDateRangeFilter");
    });
    it("buildItemReceiptByTxnIdsQbxml: lista vacía lanza", () => {
      expect(() => buildItemReceiptByTxnIdsQbxml([])).toThrow();
    });
  });
});
