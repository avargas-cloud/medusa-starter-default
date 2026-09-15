import { classifyImportedBankDocument, normalizeRefNumber, type ImportedBankEntry } from "../classify-imported";

type Acc = { id: string; name: string; account_type: string };
const CHASE: Acc = { id: "A-CHASE", name: "Chase Bank Checking 7223", account_type: "Bank" };
const TD: Acc = { id: "A-TD", name: "TD Bank Checking 9209", account_type: "Bank" };
const WELLS: Acc = { id: "A-WELLS", name: "Wells Fargo Checking 1221", account_type: "Bank" };
const AMEX: Acc = { id: "A-AMEX", name: "Amex 5009", account_type: "CreditCard" };
const RENT: Acc = { id: "A-RENT", name: "Rent Expense", account_type: "Expense" };
const FEES: Acc = { id: "A-FEES", name: "Bank Service Charges", account_type: "Expense" };
const COGS: Acc = { id: "A-COGS", name: "Cost of Goods Sold", account_type: "CostOfGoodsSold" };
const LOAN: Acc = { id: "A-LOAN", name: "SBA EIDL", account_type: "OtherCurrentLiability" };
const DEPOSITS: Acc = { id: "A-DEP", name: "Deposits to vendors", account_type: "OtherCurrentAsset" };

let seq = 0;
const dr = (account: Acc, cents: number, memo: string | null = null) => ({ line_id: `l${++seq}`, account, debit_cents: BigInt(cents), credit_cents: 0n, memo });
const cr = (account: Acc, cents: number, memo: string | null = null) => ({ line_id: `l${++seq}`, account, debit_cents: 0n, credit_cents: BigInt(cents), memo });

function entry(over: Partial<ImportedBankEntry> & Pick<ImportedBankEntry, "lines">): ImportedBankEntry {
  return { entry_id: "bje_1", txn_id: "1AAA-1", txn_type: "Check", day: "2026-03-05", ref_number: "1042", name: "Vendor A", memo: null, ...over };
}

describe("normalizeRefNumber", () => {
  it("drops the placeholders QuickBooks operators type", () => {
    for (const raw of [null, "", "  ", "N/A", "n/a", "NA", "-", "—"]) expect(normalizeRefNumber(raw)).toBeNull();
    expect(normalizeRefNumber(" 1042 ")).toBe("1042");
    expect(normalizeRefNumber("29549512780")).toBe("29549512780");
  });
});

describe("classifyImportedBankDocument — gl_check", () => {
  it("a numbered check from a bank to expenses is kind=check with signed lines", () => {
    const r = classifyImportedBankDocument(entry({ lines: [cr(CHASE, 1000_00), dr(RENT, 900_00, "march"), dr(FEES, 100_00)] }));
    expect(r.target).toBe("gl_check");
    if (r.target !== "gl_check") return;
    expect(r.kind).toBe("check");
    expect(r.number).toBe("1042");
    expect(r.bank_account).toEqual(CHASE);
    expect(r.total_cents).toBe(1000_00n);
    expect(r.lines).toEqual([
      { account: RENT, amount_cents: 900_00n, memo: "march" },
      { account: FEES, amount_cents: 100_00n, memo: null },
    ]);
  });
  it("no number (or a placeholder) → expense", () => {
    const r = classifyImportedBankDocument(entry({ ref_number: "N/A", lines: [cr(CHASE, 50_00), dr(RENT, 50_00)] }));
    expect(r.target === "gl_check" && r.kind).toBe("expense");
    expect(r.target === "gl_check" && r.number).toBeNull();
  });
  it("a Credit Card Charge is card_charge regardless of number", () => {
    const r = classifyImportedBankDocument(entry({ txn_type: "Credit Card Charge", ref_number: "77", lines: [cr(AMEX, 42_10), dr(COGS, 42_10)] }));
    expect(r.target === "gl_check" && r.kind).toBe("card_charge");
    expect(r.target === "gl_check" && r.bank_account).toEqual(AMEX);
  });
  it("a negative line (credit on an expense) survives as a negative signed line", () => {
    const r = classifyImportedBankDocument(entry({ lines: [cr(CHASE, 80_00), dr(RENT, 100_00), cr(FEES, 20_00)] }));
    expect(r.target).toBe("gl_check");
    if (r.target !== "gl_check") return;
    expect(r.total_cents).toBe(80_00n);
    expect(r.lines.map((l) => l.amount_cents)).toEqual([100_00n, -20_00n]);
  });
  it("a check to a liability or a vendor-deposit asset stays a check (it has a payee), not a transfer", () => {
    const loan = classifyImportedBankDocument(entry({ lines: [cr(CHASE, 782_71), dr(LOAN, 782_71)] }));
    expect(loan.target).toBe("gl_check");
    const wire = classifyImportedBankDocument(entry({ lines: [cr(WELLS, 5050_00), dr(DEPOSITS, 5000_00), dr(FEES, 50_00)] }));
    expect(wire.target).toBe("gl_check");
    expect(wire.target === "gl_check" && wire.lines.length).toBe(2);
  });
  it("a bank→bank+bank split (3 own accounts, no fee shape) is a check with bank lines, flagged", () => {
    const r = classifyImportedBankDocument(entry({ lines: [cr(CHASE, 300_00), dr(TD, 200_00), dr(WELLS, 100_00)] }));
    expect(r.target).toBe("gl_check");
    expect(r.target === "gl_check" && r.flags).toContain("own_accounts_split");
  });
});

describe("classifyImportedBankDocument — gl_transfer", () => {
  it("bank → bank, two lines", () => {
    const r = classifyImportedBankDocument(entry({ name: "Ecopowertech Inc", lines: [cr(CHASE, 7300_00), dr(TD, 7300_00)] }));
    expect(r).toMatchObject({ target: "gl_transfer", amount_cents: 7300_00n, fee_cents: 0n, fee_account: null, net: false });
    if (r.target !== "gl_transfer") return;
    expect(r.from).toEqual(CHASE);
    expect(r.to).toEqual(TD);
  });
  it("bank → card (paying the card) — as Check or as Credit Card Credit", () => {
    const chk = classifyImportedBankDocument(entry({ lines: [cr(CHASE, 500_00), dr(AMEX, 500_00)] }));
    expect(chk).toMatchObject({ target: "gl_transfer", amount_cents: 500_00n });
    const ccc = classifyImportedBankDocument(entry({ txn_type: "Credit Card Credit", lines: [dr(AMEX, 900_00), cr(CHASE, 900_00)] }));
    expect(ccc).toMatchObject({ target: "gl_transfer", amount_cents: 900_00n });
    expect(ccc.target === "gl_transfer" && ccc.from).toEqual(CHASE);
  });
  it("bank → bank with a wire fee to an Expense account", () => {
    const r = classifyImportedBankDocument(entry({ lines: [cr(CHASE, 1050_00), dr(WELLS, 1000_00), dr(FEES, 50_00)] }));
    expect(r).toMatchObject({ target: "gl_transfer", amount_cents: 1050_00n, fee_cents: 50_00n, net: false });
    expect(r.target === "gl_transfer" && r.fee_account).toEqual(FEES);
  });
  it("Daily Split: many lines, credits and debits on the SAME account → NET transfer, lines untouched", () => {
    const r = classifyImportedBankDocument(entry({ ref_number: "29588028951", name: "Ecopowertech Inc", memo: "Daily Split - Operating/Tax",
      lines: [cr(TD, 1000_00), cr(TD, 500_00), cr(CHASE, 2580_30), cr(TD, 1), dr(TD, 4080_31)] }));
    expect(r).toMatchObject({ target: "gl_transfer", amount_cents: 2580_30n, fee_cents: 0n, net: true, line_count: 5 });
    expect(r.target === "gl_transfer" && r.from).toEqual(CHASE);
    expect(r.target === "gl_transfer" && r.to).toEqual(TD);
  });
  it("QuickBooks 'Transfer' between a liability and a bank is a transfer (QB says so)", () => {
    const r = classifyImportedBankDocument(entry({ txn_type: "Transfer", ref_number: null, lines: [cr(LOAN, 8800_00), dr(CHASE, 8800_00)] }));
    expect(r).toMatchObject({ target: "gl_transfer", amount_cents: 8800_00n });
    expect(r.target === "gl_transfer" && r.from).toEqual(LOAN);
  });
});

describe("classifyImportedBankDocument — unmapped", () => {
  it("a real card refund (credit to an expense, debit to the card) has no positive total", () => {
    const r = classifyImportedBankDocument(entry({ txn_type: "Credit Card Credit", lines: [dr(AMEX, 139_35), cr(RENT, 139_35)] }));
    expect(r).toMatchObject({ target: "unmapped", reason: "total_not_positive" });
  });
  it("two credited accounts of which only one is a bank, plus a debit on the same non-bank → no single bank side", () => {
    const r = classifyImportedBankDocument(entry({ lines: [cr(CHASE, 5000_00), cr(DEPOSITS, 632_64), dr(RENT, 5000_00), dr(DEPOSITS, 632_64)] }));
    // DEPOSITS nets to 0 and drops out; CHASE is the only credited bank → gl_check; this is the 1-doc "Bank+OCA" case
    expect(r.target).toBe("gl_check");
    const r2 = classifyImportedBankDocument(entry({ lines: [cr(CHASE, 100_00), cr(TD, 100_00), dr(RENT, 200_00)] }));
    expect(r2).toMatchObject({ target: "unmapped", reason: "no_single_bank_side" });
  });
  it("types outside the four bank kinds are never adopted here", () => {
    for (const t of ["Bill Pmt -Check", "Bill Pmt -CCard", "Deposit", "General Journal", "Paycheck"]) {
      expect(classifyImportedBankDocument(entry({ txn_type: t, lines: [cr(CHASE, 1_00), dr(RENT, 1_00)] }))).toMatchObject({ target: "unmapped", reason: "txn_type" });
    }
  });
});
