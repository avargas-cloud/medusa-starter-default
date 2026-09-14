import {
  buildCheckAddQbxml,
  buildCreditCardChargeAddQbxml,
  buildDepositAddQbxml,
  buildJournalEntryAddQbxml,
  glQbResponseTag,
  glQbRetTag,
} from "../gl-documents/qbxml-builders";
import { buildTxnVoidQbxml } from "../txn-void-add";
import { readDirectQueryStatus } from "../gl-documents/confirm";

/** Los tags aparecen en este orden exacto (QB rechaza 0x80040400 si no). */
function expectOrder(xml: string, tags: string[]): void {
  let cursor = -1;
  for (const t of tags) {
    const idx = xml.indexOf(t);
    expect(idx).toBeGreaterThan(cursor);
    cursor = idx;
  }
}

const ASCII = /^[\x20-\x7E]*$/;

describe("buildCheckAddQbxml", () => {
  const base = {
    bankAccountListId: "80000006-BANK",
    payeeListId: "80000001-VENDOR",
    refNumber: "1234",
    txnDate: "2026-09-14",
    memo: "Uber · trip — ñandú",
    isToBePrinted: false,
    lines: [
      { accountListId: "80000090-EXP", amountCents: 615n, memo: "ride" },
      { accountListId: "80000091-EXP2", amountCents: -100, customerListId: "80000200-CUST", billable: true },
    ],
  };

  it("emits CheckAdd in the exact order: AccountRef, PayeeEntityRef, RefNumber, TxnDate, Memo, IsToBePrinted, lines", () => {
    const xml = buildCheckAddQbxml(base);
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>')).toBe(true);
    expect(xml).toContain("<CheckAddRq><CheckAdd>");
    expectOrder(xml, [
      "<AccountRef><ListID>80000006-BANK",
      "<PayeeEntityRef><ListID>80000001-VENDOR",
      "<RefNumber>1234</RefNumber>",
      "<TxnDate>2026-09-14</TxnDate>",
      "<Memo>",
      "<IsToBePrinted>false</IsToBePrinted>",
      "<ExpenseLineAdd><AccountRef><ListID>80000090-EXP</ListID></AccountRef><Amount>6.15</Amount><Memo>ride</Memo></ExpenseLineAdd>",
      "<ExpenseLineAdd><AccountRef><ListID>80000091-EXP2</ListID></AccountRef><Amount>-1.00</Amount><CustomerRef><ListID>80000200-CUST</ListID></CustomerRef><BillableStatus>Billable</BillableStatus></ExpenseLineAdd>",
    ]);
  });

  it("folds every free-text field to 7-bit ASCII", () => {
    const xml = buildCheckAddQbxml(base);
    expect(ASCII.test(xml)).toBe(true);
    expect(xml).toContain("<Memo>Uber - trip - nandu</Memo>");
  });

  it("omits PayeeEntityRef and RefNumber when absent (expense without number, payee libre)", () => {
    const xml = buildCheckAddQbxml({ ...base, payeeListId: null, refNumber: null });
    expect(xml).not.toContain("<PayeeEntityRef>");
    expect(xml).not.toContain("<RefNumber>");
    expect(xml).toContain("<IsToBePrinted>false</IsToBePrinted>");
  });

  it("rejects an empty, zero or non-positive-total line set", () => {
    expect(() => buildCheckAddQbxml({ ...base, lines: [] })).toThrow(/at least one/);
    expect(() =>
      buildCheckAddQbxml({ ...base, lines: [{ accountListId: "a", amountCents: 0n }] })
    ).toThrow(/zero/);
    expect(() =>
      buildCheckAddQbxml({ ...base, lines: [{ accountListId: "a", amountCents: -500n }] })
    ).toThrow(/positive/);
  });

  it("rejects a TxnDate that is not YYYY-MM-DD (a Date.toISOString would drift a day)", () => {
    expect(() => buildCheckAddQbxml({ ...base, txnDate: "2026-09-14T00:00:00.000Z" })).toThrow(/YYYY-MM-DD/);
  });
});

describe("buildCreditCardChargeAddQbxml", () => {
  it("puts TxnDate BEFORE RefNumber (the opposite of CheckAdd) and never emits IsToBePrinted", () => {
    const xml = buildCreditCardChargeAddQbxml({
      cardAccountListId: "8000010B-CARD",
      payeeListId: null,
      refNumber: "AUTH99",
      txnDate: "2026-06-26",
      memo: "BADUDI COM (CAD)",
      lines: [{ accountListId: "80000090-EXP", amountCents: 945 }],
    });
    expect(xml).toContain("<CreditCardChargeAddRq><CreditCardChargeAdd>");
    expectOrder(xml, [
      "<AccountRef><ListID>8000010B-CARD",
      "<TxnDate>2026-06-26</TxnDate>",
      "<RefNumber>AUTH99</RefNumber>",
      "<Memo>BADUDI COM (CAD)</Memo>",
      "<ExpenseLineAdd>",
      "<Amount>9.45</Amount>",
    ]);
    expect(xml).not.toContain("IsToBePrinted");
    expect(xml).not.toContain("<PayeeEntityRef>");
  });
});

describe("buildDepositAddQbxml", () => {
  it("emits DepositAdd: TxnDate, DepositToAccountRef, Memo, then payment lines (PaymentTxnID only) and account lines", () => {
    const xml = buildDepositAddQbxml({
      txnDate: "2026-08-03",
      depositToAccountListId: "80000006-BANK",
      memo: "ATM cash",
      lines: [
        { paymentTxnId: "1D0A48-1789000000" },
        { accountListId: "80000048-UF", amountCents: 932000n, memo: "ATM 08-03", checkNumber: null },
        { accountListId: "80000099-FEE", amountCents: -2500n, memo: "processor fee" },
      ],
    });
    expect(xml).toContain("<DepositAddRq><DepositAdd>");
    expectOrder(xml, [
      "<TxnDate>2026-08-03</TxnDate>",
      "<DepositToAccountRef><ListID>80000006-BANK</ListID></DepositToAccountRef>",
      "<Memo>ATM cash</Memo>",
      "<DepositLineAdd><PaymentTxnID>1D0A48-1789000000</PaymentTxnID></DepositLineAdd>",
      "<DepositLineAdd><AccountRef><ListID>80000048-UF</ListID></AccountRef><Memo>ATM 08-03</Memo><Amount>9320.00</Amount></DepositLineAdd>",
      "<DepositLineAdd><AccountRef><ListID>80000099-FEE</ListID></AccountRef><Memo>processor fee</Memo><Amount>-25.00</Amount></DepositLineAdd>",
    ]);
  });

  it("a payment line carries NO Amount (QuickBooks takes it from the payment in Undeposited Funds)", () => {
    const xml = buildDepositAddQbxml({
      txnDate: "2026-08-03",
      depositToAccountListId: "80000006-BANK",
      lines: [{ paymentTxnId: "1D0A48-1789000000" }],
    });
    expect(xml).not.toContain("<Amount>");
  });

  it("rejects a deposit without lines or with an empty PaymentTxnID", () => {
    const head = { txnDate: "2026-08-03", depositToAccountListId: "80000006-BANK" };
    expect(() => buildDepositAddQbxml({ ...head, lines: [] })).toThrow(/at least one/);
    expect(() => buildDepositAddQbxml({ ...head, lines: [{ paymentTxnId: "" }] })).toThrow(/PaymentTxnID/);
  });
});

describe("buildJournalEntryAddQbxml", () => {
  const lines = [
    { side: "debit" as const, accountListId: "80000006-CHASE", amountCents: 99000n, memo: "transfer in" },
    { side: "debit" as const, accountListId: "80000099-FEE", amountCents: 1000n, memo: "wire fee" },
    { side: "credit" as const, accountListId: "800000D9-WELLS", amountCents: 100000n, memo: "transfer out" },
  ];

  it("emits TxnDate, RefNumber, all debit lines, then all credit lines", () => {
    const xml = buildJournalEntryAddQbxml({ txnDate: "2026-09-14", refNumber: "TRF-1001", lines });
    expect(xml).toContain("<JournalEntryAddRq><JournalEntryAdd>");
    expectOrder(xml, [
      "<TxnDate>2026-09-14</TxnDate>",
      "<RefNumber>TRF-1001</RefNumber>",
      "<JournalDebitLine><AccountRef><ListID>80000006-CHASE</ListID></AccountRef><Amount>990.00</Amount><Memo>transfer in</Memo></JournalDebitLine>",
      "<JournalDebitLine><AccountRef><ListID>80000099-FEE</ListID></AccountRef><Amount>10.00</Amount>",
      "<JournalCreditLine><AccountRef><ListID>800000D9-WELLS</ListID></AccountRef><Amount>1000.00</Amount>",
    ]);
  });

  it("emits EntityRef on the line that carries one (A/R, A/P)", () => {
    const xml = buildJournalEntryAddQbxml({
      txnDate: "2026-09-14",
      lines: [
        { side: "debit", accountListId: "80000047-AR", amountCents: 500n, entityListId: "80000200-CUST" },
        { side: "credit", accountListId: "8000000B-INC", amountCents: 500n },
      ],
    });
    expect(xml).toContain("<Amount>5.00</Amount><EntityRef><ListID>80000200-CUST</ListID></EntityRef></JournalDebitLine>");
  });

  it("refuses an unbalanced or one-sided entry", () => {
    expect(() =>
      buildJournalEntryAddQbxml({ txnDate: "2026-09-14", lines: [lines[0]!, { ...lines[2]!, amountCents: 1n }] })
    ).toThrow(/unbalanced/);
    expect(() => buildJournalEntryAddQbxml({ txnDate: "2026-09-14", lines: [lines[0]!] })).toThrow(/at least one debit line and one credit line/);
    expect(() =>
      buildJournalEntryAddQbxml({
        txnDate: "2026-09-14",
        lines: [{ ...lines[0]!, amountCents: -5n }, { ...lines[2]!, amountCents: -5n }],
      })
    ).toThrow(/positive/);
  });
});

describe("TxnVoid for the GL document types", () => {
  it("names each type exactly as its ADD created it", () => {
    for (const type of ["Check", "CreditCardCharge", "Deposit", "JournalEntry"] as const) {
      expect(buildTxnVoidQbxml(type, "1D0A48-1789000000")).toContain(
        `<TxnVoidRq><TxnVoidType>${type}</TxnVoidType><TxnID>1D0A48-1789000000</TxnID></TxnVoidRq>`
      );
      expect(glQbResponseTag(type)).toBe(`${type}AddRs`);
      expect(glQbRetTag(type)).toBe(`${type}Ret`);
    }
  });
});

describe("readDirectQueryStatus", () => {
  it("reads the attributes the bridge leaves under `$` (real prod shape of a confirmed vendor_credit_add)", () => {
    const rs = {
      $: { statusCode: "0", statusMessage: "Status OK", statusSeverity: "Info" },
      VendorCreditRet: { TxnID: "1D0AFD-1789143761" },
    };
    expect(readDirectQueryStatus(rs)).toEqual({ statusCode: "0", statusMessage: "Status OK" });
  });

  it("surfaces a rejection instead of reading it as null (the latent false-confirm)", () => {
    const rs = { $: { statusCode: "3120", statusMessage: "Object not found" } };
    expect(readDirectQueryStatus(rs).statusCode).toBe("3120");
  });

  it("accepts the flat form too, and null when there is no node", () => {
    expect(readDirectQueryStatus({ statusCode: 500, statusMessage: "x" })).toEqual({ statusCode: "500", statusMessage: "x" });
    expect(readDirectQueryStatus(undefined)).toEqual({ statusCode: null, statusMessage: "" });
  });
});
