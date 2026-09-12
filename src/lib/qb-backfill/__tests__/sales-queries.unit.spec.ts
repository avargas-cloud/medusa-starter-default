import {
  buildInvoiceQbxml,
  buildSalesReceiptQbxml,
  buildReceivePaymentQbxml,
  buildCreditMemoQbxml,
  buildInvoiceUnpaidQbxml,
  buildBillUnpaidQbxml,
  buildInvoiceByTxnIdsQbxml,
  buildCreditMemoByTxnIdsQbxml,
  buildSalesReceiptByTxnIdsQbxml,
  buildReceivePaymentByTxnIdsQbxml,
  SALES_RS_KEYS,
  SALES_RET_KEYS,
} from "../sales-queries";

describe("qb-backfill/sales-queries", () => {
  describe("builders por ventana", () => {
    it("InvoiceQueryRq: TxnDateRangeFilter antes de IncludeLineItems/IncludeLinkedTxns", () => {
      const xml = buildInvoiceQbxml("2026-01-01", "2026-01-31");
      const iDate = xml.indexOf("TxnDateRangeFilter");
      const iItems = xml.indexOf("IncludeLineItems");
      const iLinked = xml.indexOf("IncludeLinkedTxns");
      expect(iDate).toBeGreaterThan(-1);
      expect(iItems).toBeGreaterThan(iDate);
      expect(iLinked).toBeGreaterThan(iItems);
    });
    it("SalesReceiptQueryRq: fecha → líneas, y NUNCA IncludeLinkedTxns (0x80040400 sondeado 2026-09-11)", () => {
      const xml = buildSalesReceiptQbxml("2026-01-01", "2026-01-31");
      const iDate = xml.indexOf("TxnDateRangeFilter");
      const iItems = xml.indexOf("IncludeLineItems");
      expect(iItems).toBeGreaterThan(iDate);
      expect(xml).not.toContain("IncludeLinkedTxns");
    });
    it("CreditMemoQueryRq: mismo orden", () => {
      const xml = buildCreditMemoQbxml("2026-01-01", "2026-01-31");
      const iDate = xml.indexOf("TxnDateRangeFilter");
      const iItems = xml.indexOf("IncludeLineItems");
      const iLinked = xml.indexOf("IncludeLinkedTxns");
      expect(iItems).toBeGreaterThan(iDate);
      expect(iLinked).toBeGreaterThan(iItems);
    });
    it("ReceivePaymentQueryRq: NUNCA IncludeLinkedTxns (no válido para este tipo)", () => {
      const xml = buildReceivePaymentQbxml("2026-01-01", "2026-01-31");
      expect(xml).not.toContain("IncludeLinkedTxns");
      expect(xml).toContain("<IncludeLineItems>true</IncludeLineItems>");
      expect(xml).toContain("TxnDateRangeFilter");
    });
    it("fecha inválida lanza", () => {
      expect(() => buildInvoiceQbxml("2026/01/01", "2026-01-31")).toThrow();
      expect(() => buildReceivePaymentQbxml("2026-01-01", "not-a-date")).toThrow();
    });
    it("envelope completo con onError=stopOnError", () => {
      const xml = buildInvoiceQbxml("2026-01-01", "2026-01-31");
      expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
      expect(xml).toContain('<?qbxml version="10.0"?>');
      expect(xml).toContain('onError="stopOnError"');
    });
  });

  describe("PaidStatus (unpaid-only)", () => {
    it("InvoiceQueryRq: PaidStatus va DESPUÉS de TxnDateRangeFilter y ANTES de IncludeLineItems", () => {
      const xml = buildInvoiceUnpaidQbxml("2026-01-01", "2026-01-31");
      const iDate = xml.indexOf("TxnDateRangeFilter");
      const iPaid = xml.indexOf("PaidStatus");
      const iItems = xml.indexOf("IncludeLineItems");
      expect(iPaid).toBeGreaterThan(iDate);
      expect(iItems).toBeGreaterThan(iPaid);
      expect(xml).toContain("<PaidStatus>NotPaidOnly</PaidStatus>");
    });
    it("BillQueryRq unpaid: mismo shape que Invoice", () => {
      const xml = buildBillUnpaidQbxml("2026-01-01", "2026-01-31");
      const iDate = xml.indexOf("TxnDateRangeFilter");
      const iPaid = xml.indexOf("PaidStatus");
      const iItems = xml.indexOf("IncludeLineItems");
      expect(iPaid).toBeGreaterThan(iDate);
      expect(iItems).toBeGreaterThan(iPaid);
      expect(xml).toContain("<BillQueryRq");
    });
  });

  describe("builders by-TxnID", () => {
    it("buildInvoiceByTxnIdsQbxml: un <TxnID> por id, sin TxnDateRangeFilter, con IncludeLinkedTxns", () => {
      const xml = buildInvoiceByTxnIdsQbxml(["T1", "T2"]);
      expect(xml).toContain("<InvoiceQueryRq");
      expect(xml).toContain("<TxnID>T1</TxnID>");
      expect(xml).toContain("<TxnID>T2</TxnID>");
      expect(xml).not.toContain("TxnDateRangeFilter");
      expect(xml).toContain("<IncludeLinkedTxns>true</IncludeLinkedTxns>");
    });
    it("buildCreditMemoByTxnIdsQbxml: mismo patrón", () => {
      const xml = buildCreditMemoByTxnIdsQbxml(["T1"]);
      expect(xml).toContain("<CreditMemoQueryRq");
      expect(xml).toContain("<TxnID>T1</TxnID>");
      expect(xml).toContain("<IncludeLinkedTxns>true</IncludeLinkedTxns>");
    });
    it("buildSalesReceiptByTxnIdsQbxml: SIN IncludeLinkedTxns", () => {
      const xml = buildSalesReceiptByTxnIdsQbxml(["T1"]);
      expect(xml).toContain("<SalesReceiptQueryRq");
      expect(xml).toContain("<TxnID>T1</TxnID>");
      expect(xml).not.toContain("IncludeLinkedTxns");
    });
    it("buildReceivePaymentByTxnIdsQbxml: SIN IncludeLinkedTxns", () => {
      const xml = buildReceivePaymentByTxnIdsQbxml(["T1"]);
      expect(xml).toContain("<ReceivePaymentQueryRq");
      expect(xml).toContain("<TxnID>T1</TxnID>");
      expect(xml).not.toContain("IncludeLinkedTxns");
      expect(xml).toContain("<IncludeLineItems>true</IncludeLineItems>");
    });
    it("lista vacía lanza en los 4", () => {
      expect(() => buildInvoiceByTxnIdsQbxml([])).toThrow();
      expect(() => buildCreditMemoByTxnIdsQbxml([])).toThrow();
      expect(() => buildSalesReceiptByTxnIdsQbxml([])).toThrow();
      expect(() => buildReceivePaymentByTxnIdsQbxml([])).toThrow();
    });
  });

  describe("SALES_RS_KEYS / SALES_RET_KEYS", () => {
    it("mapean los 4 tipos a su Rs/Ret", () => {
      expect(SALES_RS_KEYS.invoice).toBe("InvoiceQueryRs");
      expect(SALES_RS_KEYS.sales_receipt).toBe("SalesReceiptQueryRs");
      expect(SALES_RS_KEYS.receive_payment).toBe("ReceivePaymentQueryRs");
      expect(SALES_RS_KEYS.credit_memo).toBe("CreditMemoQueryRs");
      expect(SALES_RET_KEYS.invoice).toBe("InvoiceRet");
      expect(SALES_RET_KEYS.sales_receipt).toBe("SalesReceiptRet");
      expect(SALES_RET_KEYS.receive_payment).toBe("ReceivePaymentRet");
      expect(SALES_RET_KEYS.credit_memo).toBe("CreditMemoRet");
    });
  });
});
