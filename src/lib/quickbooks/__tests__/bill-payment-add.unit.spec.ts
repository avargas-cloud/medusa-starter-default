import {
  buildBillPaymentCheckAddQbxml,
  buildBillPaymentCreditCardAddQbxml,
} from "../bill-payment-add";

const BASE = {
  payeeListId: "80000001-VENDOR",
  apAccountListId: "80000002-AP",
  txnDate: "2026-09-10",
  refNumber: "BP-1001",
  memo: "Pay bill VB-2001",
  appliedToTxns: [
    {
      billTxnId: "9000AAA-BILL",
      paymentAmountCents: 10000,
      setCredits: [{ creditTxnId: "9000BBB-CREDIT", appliedAmountCents: 2000 }],
    },
  ],
};

describe("buildBillPaymentCheckAddQbxml", () => {
  it("emits elements in the exact §4 Check order", () => {
    const xml = buildBillPaymentCheckAddQbxml({
      ...BASE,
      bankAccountListId: "80000005-BANK",
    });
    const order = [
      "<PayeeEntityRef>",
      "<APAccountRef>",
      "<TxnDate>",
      "<BankAccountRef>",
      "<IsToBePrinted>",
      "<RefNumber>",
      "<Memo>",
      "<AppliedToTxnAdd>",
      "<TxnID>",
      "<PaymentAmount>",
      "<SetCredit>",
      "<CreditTxnID>",
      "<AppliedAmount>",
    ];
    let cursor = -1;
    for (const tag of order) {
      const idx = xml.indexOf(tag);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
    expect(xml).toContain("<IsToBePrinted>false</IsToBePrinted>");
    expect(xml).toContain("<BillPaymentCheckAddRq><BillPaymentCheckAdd>");
  });

  it("formats amounts as dollar strings", () => {
    const xml = buildBillPaymentCheckAddQbxml({
      ...BASE,
      bankAccountListId: "80000005-BANK",
    });
    expect(xml).toContain("<PaymentAmount>100.00</PaymentAmount>");
    expect(xml).toContain("<AppliedAmount>20.00</AppliedAmount>");
  });

  it("accepts a zero PaymentAmount (credit-only application)", () => {
    const xml = buildBillPaymentCheckAddQbxml({
      ...BASE,
      bankAccountListId: "80000005-BANK",
      appliedToTxns: [
        {
          billTxnId: "9000AAA-BILL",
          paymentAmountCents: 0,
          setCredits: [{ creditTxnId: "9000BBB-CREDIT", appliedAmountCents: 2000 }],
        },
      ],
    });
    expect(xml).toContain("<PaymentAmount>0.00</PaymentAmount>");
  });

  it("supports multiple AppliedToTxnAdd (multi-bill payment)", () => {
    const xml = buildBillPaymentCheckAddQbxml({
      ...BASE,
      bankAccountListId: "80000005-BANK",
      appliedToTxns: [
        { billTxnId: "BILL-A", paymentAmountCents: 500 },
        { billTxnId: "BILL-B", paymentAmountCents: 700 },
      ],
    });
    expect(xml.match(/<AppliedToTxnAdd>/g)?.length).toBe(2);
  });

  it("throws without a bank account", () => {
    expect(() =>
      buildBillPaymentCheckAddQbxml({ ...BASE, bankAccountListId: "" })
    ).toThrow(/BankAccountRef/);
  });

  it("throws without a payee", () => {
    expect(() =>
      buildBillPaymentCheckAddQbxml({
        ...BASE,
        payeeListId: "",
        bankAccountListId: "80000005-BANK",
      })
    ).toThrow(/PayeeEntityRef/);
  });

  it("throws with no AppliedToTxnAdd", () => {
    expect(() =>
      buildBillPaymentCheckAddQbxml({
        ...BASE,
        bankAccountListId: "80000005-BANK",
        appliedToTxns: [],
      })
    ).toThrow(/AppliedToTxnAdd/);
  });

  it("throws when an AppliedToTxnAdd has no bill TxnID", () => {
    expect(() =>
      buildBillPaymentCheckAddQbxml({
        ...BASE,
        bankAccountListId: "80000005-BANK",
        appliedToTxns: [{ billTxnId: "", paymentAmountCents: 100 }],
      })
    ).toThrow(/bill's qb_txn_id/);
  });

  it("throws when a SetCredit has no credit TxnID", () => {
    expect(() =>
      buildBillPaymentCheckAddQbxml({
        ...BASE,
        bankAccountListId: "80000005-BANK",
        appliedToTxns: [
          {
            billTxnId: "BILL-A",
            paymentAmountCents: 100,
            setCredits: [{ creditTxnId: "", appliedAmountCents: 50 }],
          },
        ],
      })
    ).toThrow(/vendor credit's qb_txn_id/);
  });
});

describe("buildBillPaymentCreditCardAddQbxml", () => {
  it("emits elements in the exact §4 CreditCard order (no IsToBePrinted)", () => {
    const xml = buildBillPaymentCreditCardAddQbxml({
      ...BASE,
      creditCardAccountListId: "80000006-CARD",
    });
    const order = [
      "<PayeeEntityRef>",
      "<APAccountRef>",
      "<TxnDate>",
      "<CreditCardAccountRef>",
      "<RefNumber>",
      "<Memo>",
      "<AppliedToTxnAdd>",
    ];
    let cursor = -1;
    for (const tag of order) {
      const idx = xml.indexOf(tag);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
    expect(xml).not.toContain("<IsToBePrinted>");
    expect(xml).toContain(
      "<BillPaymentCreditCardAddRq><BillPaymentCreditCardAdd>"
    );
  });

  it("throws without a credit card account", () => {
    expect(() =>
      buildBillPaymentCreditCardAddQbxml({ ...BASE, creditCardAccountListId: "" })
    ).toThrow(/CreditCardAccountRef/);
  });
});
