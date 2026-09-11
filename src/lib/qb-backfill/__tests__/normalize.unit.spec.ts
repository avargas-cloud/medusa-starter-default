import { moneyToCents, normalizeRef, normalizeLinkedTxns, normalizePurchaseOrders } from "../normalize";

describe("qb-backfill/normalize", () => {
  describe("moneyToCents", () => {
    it("convierte un string decimal simple", () => {
      expect(moneyToCents("380.64")).toBe(38064);
    });
    it("convierte enteros sin punto decimal", () => {
      expect(moneyToCents("1234")).toBe(123400);
    });
    it("respeta el signo negativo", () => {
      expect(moneyToCents("-19812.00")).toBe(-1981200);
      expect(moneyToCents("-1.5")).toBe(-150);
    });
    it("nunca introduce error de punto flotante binario (0.1+0.2 sample)", () => {
      // parseFloat("0.29") * 100 da 28.999999999999996 en JS — el bug clásico.
      expect(moneyToCents("0.29")).toBe(29);
      expect(moneyToCents("2503.55")).toBe(250355);
    });
    it("null/undefined/'' → 0", () => {
      expect(moneyToCents(null)).toBe(0);
      expect(moneyToCents(undefined)).toBe(0);
      expect(moneyToCents("")).toBe(0);
    });
    it("trunca más de 2 decimales en vez de redondear con error", () => {
      expect(moneyToCents("1.239")).toBe(123);
    });
    it("rechaza basura no numérica", () => {
      expect(() => moneyToCents("abc")).toThrow();
    });
  });

  describe("normalizeRef", () => {
    it("null cuando no hay ListID", () => {
      expect(normalizeRef(undefined)).toBeNull();
      expect(normalizeRef({})).toBeNull();
    });
    it("mapea ListID/FullName", () => {
      expect(normalizeRef({ ListID: "800018B4-1621454061", FullName: "VEETECH Co., Ltd" })).toEqual({
        list_id: "800018B4-1621454061",
        full_name: "VEETECH Co., Ltd",
      });
    });
  });

  describe("normalizeLinkedTxns", () => {
    it("normaliza dict único a lista de 1", () => {
      const out = normalizeLinkedTxns({
        LinkedTxn: { TxnID: "1", TxnType: "Bill", TxnDate: "2026-01-01", Amount: "10.00" },
      });
      expect(out).toEqual([{ txn_id: "1", txn_type: "Bill", txn_date: "2026-01-01", amount_cents: 1000, ref_number: null }]);
    });
    it("sin LinkedTxn → []", () => {
      expect(normalizeLinkedTxns({})).toEqual([]);
    });
  });

  describe("normalizePurchaseOrders", () => {
    it("rs null → []", () => {
      expect(normalizePurchaseOrders(null)).toEqual([]);
    });
    it("normaliza un PO con una línea (forma sondeada 2026-09-11)", () => {
      const rs = {
        PurchaseOrderRet: {
          TxnID: "1CEFD4-1788381863",
          EditSequence: "1788897729",
          TxnNumber: "149735",
          VendorRef: { ListID: "800018B4-1621454061", FullName: "VEETECH Co., Ltd" },
          TxnDate: "2026-09-02",
          RefNumber: "174408",
          ExpectedDate: "2026-09-14",
          TotalAmount: "2503.55",
          IsManuallyClosed: "false",
          IsFullyReceived: "false",
          Memo: "Medusa PO 1168",
          PurchaseOrderLineRet: {
            TxnLineID: "1CEFD6-1788381863",
            ItemRef: { ListID: "80001A7D-1723479283", FullName: "EMSH4V160D15W30" },
            Desc: "FPC LED Module",
            Quantity: "40",
            Rate: "15.86",
            Amount: "634.40",
            ReceivedQuantity: "0",
            IsManuallyClosed: "false",
          },
        },
      };
      const [po] = normalizePurchaseOrders(rs);
      expect(po).toBeDefined();
      expect(po!.txn_id).toBe("1CEFD4-1788381863");
      expect(po!.total_amount_cents).toBe(250355);
      expect(po!.is_fully_received).toBe(false);
      expect(po!.lines).toHaveLength(1);
      expect(po!.lines[0]!.amount_cents).toBe(63440);
      expect(po!.lines[0]!.rate_cents).toBe(1586);
      expect(po!.lines[0]!.quantity).toBe(40);
    });
  });
});
