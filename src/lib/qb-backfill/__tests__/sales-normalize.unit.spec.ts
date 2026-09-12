import {
  normalizeInvoices,
  normalizeSalesReceipts,
  normalizeReceivePayments,
  normalizeCreditMemos,
} from "../sales-normalize";

describe("qb-backfill/sales-normalize", () => {
  describe("normalizeInvoices", () => {
    it("rs null → []", () => {
      expect(normalizeInvoices(null)).toEqual([]);
    });
    it("single InvoiceRet (dict, no array) con una línea simple", () => {
      const rs = {
        InvoiceRet: {
          TxnID: "INV1",
          EditSequence: "1",
          CustomerRef: { ListID: "80001", FullName: "Acme Co" },
          TxnDate: "2026-01-05",
          RefNumber: "S1001",
          IsPending: "false",
          IsPaid: "false",
          Subtotal: "1234.56",
          SalesTaxTotal: "0.00",
          AppliedAmount: "0.00",
          BalanceRemaining: "1234.56",
          Memo: "test",
          InvoiceLineRet: {
            TxnLineID: "L1",
            ItemRef: { ListID: "8IT1", FullName: "SKU-1" },
            Desc: "line 1",
            Quantity: "2",
            Rate: "617.28",
            Amount: "1234.56",
          },
        },
      };
      const [inv] = normalizeInvoices(rs);
      expect(inv).toBeDefined();
      expect(inv!.txn_id).toBe("INV1");
      // moneyToCents (ver normalize.ts) NO soporta separador de miles — QB
      // manda montos sin coma en QBXML (el formato con coma es sólo de UI).
      expect(inv!.balance_remaining_cents).toBe(123456);
      expect(inv!.lines).toHaveLength(1);
      expect(inv!.lines[0]!.amount_cents).toBe(123456);
      expect(inv!.lines[0]!.is_group_child).toBeUndefined();
    });
    it("array de InvoiceRet (2 facturas)", () => {
      const rs = {
        InvoiceRet: [
          { TxnID: "INV1", EditSequence: "1", TxnDate: "2026-01-01", Subtotal: "10.00", SalesTaxTotal: "0.00", AppliedAmount: "0.00", BalanceRemaining: "10.00" },
          { TxnID: "INV2", EditSequence: "1", TxnDate: "2026-01-02", Subtotal: "20.00", SalesTaxTotal: "0.00", AppliedAmount: "0.00", BalanceRemaining: "20.00" },
        ],
      };
      const out = normalizeInvoices(rs);
      expect(out).toHaveLength(2);
      expect(out.map((i) => i.txn_id)).toEqual(["INV1", "INV2"]);
    });
    it("InvoiceLineGroupRet se aplana con is_group_child=true, sin sumar el Amount del grupo", () => {
      const rs = {
        InvoiceRet: {
          TxnID: "INV2",
          EditSequence: "1",
          TxnDate: "2026-01-06",
          Subtotal: "100.00",
          SalesTaxTotal: "0.00",
          AppliedAmount: "0.00",
          BalanceRemaining: "100.00",
          InvoiceLineGroupRet: {
            TxnLineID: "G1",
            ItemGroupRef: { ListID: "8GR1", FullName: "KIT-1" },
            TotalAmount: "100.00",
            InvoiceLineRet: [
              { TxnLineID: "G1-A", ItemRef: { ListID: "8A", FullName: "A" }, Amount: "60.00" },
              { TxnLineID: "G1-B", ItemRef: { ListID: "8B", FullName: "B" }, Amount: "40.00" },
            ],
          },
        },
      };
      const [inv] = normalizeInvoices(rs);
      expect(inv!.lines).toHaveLength(2);
      expect(inv!.lines.every((l) => l.is_group_child)).toBe(true);
      const total = inv!.lines.reduce((acc, l) => acc + l.amount_cents, 0);
      expect(total).toBe(10000); // 60+40, NUNCA 60+40+100 (el TotalAmount del grupo no entra)
    });
    it("Subtotal/Discount/SalesTax como pseudo-línea se conserva tal cual", () => {
      const rs = {
        InvoiceRet: {
          TxnID: "INV3",
          EditSequence: "1",
          TxnDate: "2026-01-07",
          Subtotal: "90.00",
          SalesTaxTotal: "10.00",
          AppliedAmount: "0.00",
          BalanceRemaining: "100.00",
          InvoiceLineRet: [
            { TxnLineID: "L1", ItemRef: { ListID: "8A", FullName: "A" }, Amount: "100.00" },
            { TxnLineID: "L2", ItemRef: { ListID: "8TAX", FullName: "Sales Tax" }, Amount: "10.00" },
          ],
        },
      };
      const [inv] = normalizeInvoices(rs);
      expect(inv!.lines).toHaveLength(2);
      expect(inv!.lines[1]!.item_ref?.full_name).toBe("Sales Tax");
    });
  });

  describe("normalizeSalesReceipts", () => {
    it("rs null → []", () => {
      expect(normalizeSalesReceipts(null)).toEqual([]);
    });
    it("normaliza total/payment/deposit refs", () => {
      const rs = {
        SalesReceiptRet: {
          TxnID: "SR1",
          EditSequence: "1",
          TxnDate: "2026-01-08",
          Subtotal: "50.00",
          SalesTaxTotal: "0.00",
          TotalAmount: "50.00",
          PaymentMethodRef: { ListID: "8PM1", FullName: "Cash" },
          DepositToAccountRef: { ListID: "8DEP1", FullName: "Undeposited Funds" },
          CheckNumber: "9999",
          SalesReceiptLineRet: { TxnLineID: "L1", ItemRef: { ListID: "8A", FullName: "A" }, Amount: "50.00" },
        },
      };
      const [sr] = normalizeSalesReceipts(rs);
      expect(sr!.total_amount_cents).toBe(5000);
      expect(sr!.payment_method_ref?.full_name).toBe("Cash");
      expect(sr!.deposit_to_account_ref?.full_name).toBe("Undeposited Funds");
      expect(sr!.check_number).toBe("9999");
      expect(sr!.lines).toHaveLength(1);
    });
  });

  describe("normalizeReceivePayments", () => {
    it("rs null → []", () => {
      expect(normalizeReceivePayments(null)).toEqual([]);
    });
    it("dos AppliedToTxnRet y un SetCredit anidado", () => {
      const rs = {
        ReceivePaymentRet: {
          TxnID: "RP1",
          EditSequence: "1",
          CustomerRef: { ListID: "8C1", FullName: "Acme Co" },
          ARAccountRef: { ListID: "8AR1", FullName: "Accounts Receivable" },
          TxnDate: "2026-01-09",
          RefNumber: "CHK-1",
          TotalAmount: "300.00",
          PaymentMethodRef: { ListID: "8PM1", FullName: "Check" },
          DepositToAccountRef: { ListID: "8DEP1", FullName: "Undeposited Funds" },
          UnusedPayment: "0.00",
          UnusedCredits: "0.00",
          AppliedToTxnRet: [
            {
              TxnID: "INV1",
              TxnType: "Invoice",
              TxnDate: "2026-01-05",
              RefNumber: "S1001",
              BalanceRemaining: "0.00",
              Amount: "200.00",
              DiscountAmount: "0.00",
            },
            {
              TxnID: "INV2",
              TxnType: "Invoice",
              TxnDate: "2026-01-06",
              RefNumber: "S1002",
              BalanceRemaining: "0.00",
              Amount: "100.00",
              SetCredit: { CreditTxnID: "CM1", AppliedAmount: "25.00" },
            },
          ],
        },
      };
      const [rp] = normalizeReceivePayments(rs);
      expect(rp!.applied).toHaveLength(2);
      expect(rp!.applied[0]!.amount_cents).toBe(20000);
      expect(rp!.applied[1]!.set_credits).toEqual([{ credit_txn_id: "CM1", applied_amount_cents: 2500 }]);
      expect(rp!.total_amount_cents).toBe(30000);
    });
    it("AppliedToTxnRet único (dict) se normaliza a lista de 1", () => {
      const rs = {
        ReceivePaymentRet: {
          TxnID: "RP2",
          EditSequence: "1",
          TxnDate: "2026-01-10",
          TotalAmount: "50.00",
          UnusedPayment: "0.00",
          UnusedCredits: "0.00",
          AppliedToTxnRet: { TxnID: "INV3", TxnType: "Invoice", Amount: "50.00" },
        },
      };
      const [rp] = normalizeReceivePayments(rs);
      expect(rp!.applied).toHaveLength(1);
      expect(rp!.applied[0]!.set_credits).toEqual([]);
    });
  });

  describe("normalizeCreditMemos", () => {
    it("rs null → []", () => {
      expect(normalizeCreditMemos(null)).toEqual([]);
    });
    it("normaliza montos negativos correctamente (moneyToCents soporta signo, no comas)", () => {
      const rs = {
        CreditMemoRet: {
          TxnID: "CM1",
          EditSequence: "1",
          CustomerRef: { ListID: "8C1", FullName: "Acme Co" },
          TxnDate: "2026-01-11",
          IsPending: "false",
          Subtotal: "25.00",
          SalesTaxTotal: "0.00",
          TotalAmount: "25.00",
          CreditRemaining: "25.00",
          LinkedTxn: { TxnID: "RP1", TxnType: "ReceivePayment", TxnDate: "2026-01-09", Amount: "-25.00" },
          CreditMemoLineRet: { TxnLineID: "L1", ItemRef: { ListID: "8A", FullName: "A" }, Amount: "25.00" },
        },
      };
      const [cm] = normalizeCreditMemos(rs);
      expect(cm!.credit_remaining_cents).toBe(2500);
      expect(cm!.linked_txns).toEqual([
        { txn_id: "RP1", txn_type: "ReceivePayment", txn_date: "2026-01-09", amount_cents: -2500, ref_number: null },
      ]);
      expect(cm!.lines).toHaveLength(1);
    });
    it("CreditMemoLineGroupRet aplana igual que Invoice", () => {
      const rs = {
        CreditMemoRet: {
          TxnID: "CM2",
          EditSequence: "1",
          TxnDate: "2026-01-12",
          Subtotal: "30.00",
          SalesTaxTotal: "0.00",
          TotalAmount: "30.00",
          CreditRemaining: "30.00",
          CreditMemoLineGroupRet: {
            TxnLineID: "G1",
            TotalAmount: "30.00",
            CreditMemoLineRet: [
              { TxnLineID: "G1-A", Amount: "10.00" },
              { TxnLineID: "G1-B", Amount: "20.00" },
            ],
          },
        },
      };
      const [cm] = normalizeCreditMemos(rs);
      expect(cm!.lines).toHaveLength(2);
      expect(cm!.lines.every((l) => l.is_group_child)).toBe(true);
      expect(cm!.lines.reduce((acc, l) => acc + l.amount_cents, 0)).toBe(3000);
    });
  });

  describe("moneyToCents con montos QB reales (via normalizadores)", () => {
    it("string sin comas con decimales '1234.56'", () => {
      const rs = { InvoiceRet: { TxnID: "X", EditSequence: "1", TxnDate: "2026-01-01", Subtotal: "1234.56", SalesTaxTotal: "0.00", AppliedAmount: "0.00", BalanceRemaining: "1234.56" } };
      expect(normalizeInvoices(rs)[0]!.subtotal_cents).toBe(123456);
    });
    it("negativo '-25.00'", () => {
      const rs = { CreditMemoRet: { TxnID: "X", EditSequence: "1", TxnDate: "2026-01-01", Subtotal: "25.00", SalesTaxTotal: "0.00", TotalAmount: "25.00", CreditRemaining: "25.00", LinkedTxn: { TxnID: "A", TxnType: "Bill", Amount: "-25.00" } } };
      expect(normalizeCreditMemos(rs)[0]!.linked_txns[0]!.amount_cents).toBe(-2500);
    });
  });
});
