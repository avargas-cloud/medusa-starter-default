import type { PoolClient } from "pg";
import { paymentEconomicStatus, matchesPaymentFingerprint } from "../../lib/banking/payment-evidence";
import { guardDepositEdit, validateDepositReceipt } from "../../lib/banking/deposit-validation";
import { persistReview, type ReviewContext } from "../../lib/banking/review-core";
import { requireUnpostedBankAccount } from "../../lib/banking/review-setup";
import type { Review } from "../../lib/banking/review-types";

const newHash = "a".repeat(32);
const oldHash = "b".repeat(32);

describe("receipt evidence version compatibility", () => {
  test.each(["available", "partially_applied", "applied"])("AR state %s is the same monetary receipt", status => {
    expect(paymentEconomicStatus(status)).toBe("available");
  });
  test.each(["voided", "refunded", "partial_refunded", "unknown"])("economic state %s never becomes ordinary available credit", status => {
    expect(paymentEconomicStatus(status)).toBe(status);
    expect(paymentEconomicStatus(status)).not.toBe(paymentEconomicStatus("applied"));
  });
  it("accepts an unchanged legacy source on explicit save without accepting another historical version", () => {
    const current = { source_hash: newHash, legacy_source_hash: oldHash };
    expect(matchesPaymentFingerprint(oldHash, current)).toBe(true);
    expect(matchesPaymentFingerprint(newHash, current)).toBe(true);
    expect(matchesPaymentFingerprint("c".repeat(32), current)).toBe(false);
  });
});

describe("deposit validation against unified capacity", () => {
  const payment = { id: "cpay", source_hash: newHash, legacy_source_hash: oldHash,
    fingerprint_version: 2, available_amount: "40.01", unreserved: true };
  function reader(row: typeof payment | undefined): PoolClient {
    return { query: jest.fn(async () => ({ rows: row ? [row] : [] })) } as unknown as PoolClient;
  }
  const validate = (client: PoolClient, amount: string, hash = newHash) =>
    validateDepositReceipt(client, "cpay", "deposit", "USD", "2026-09-01", "2026-09-08", amount, hash);
  it("accepts the exact remaining physical receipt, regardless of invoice allocation", async () => {
    await expect(validate(reader(payment), "40.01")).resolves.toEqual(payment);
  });
  it("rejects just one extra cent while allowing the exact boundary", async () => {
    await expect(validate(reader(payment), "40.02")).rejects.toThrow("BANKING_DEPOSIT_OVER_RESERVED");
  });
  it("does not round an exhausted source back into available money", async () => {
    await expect(validate(reader({ ...payment, available_amount: "0.00" }), "0.01"))
      .rejects.toThrow("BANKING_DEPOSIT_OVER_RESERVED");
  });
  it("accepts a still-current legacy fingerprint but rejects economic drift", async () => {
    await expect(validate(reader(payment), "20.00", oldHash)).resolves.toEqual(payment);
    await expect(validate(reader(payment), "20.00", "c".repeat(32))).rejects.toThrow("BANKING_DEPOSIT_SOURCE_STALE");
  });
  it("does not consume capacity of an absent/refunded source or another direct reservation", async () => {
    await expect(validate(reader(undefined), "1.00")).rejects.toThrow("BANKING_DEPOSIT_SOURCE_STALE");
    await expect(validate(reader({ ...payment, unreserved: false }), "1.00")).rejects.toThrow("BANKING_DEPOSIT_OVER_RESERVED");
  });
});

describe("posted deposit and account guards", () => {
  function reader(posted: boolean, closed: boolean) {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes("FROM bank_journal_entry entry")) return { rows: posted ? [{ id: "posted" }] : [], rowCount: posted ? 1 : 0 };
      if (sql.includes("FROM bank_opening_balance b")) return { rows: [], rowCount: 0 };
      if (sql.includes("bank_day_close")) return { rows: [{ closed }], rowCount: 1 };
      throw new Error(`Unexpected guard query: ${sql}`);
    });
    return { client: { query } as unknown as PoolClient, query };
  }
  it("requires reversal before changing a posted deposit even on an open review day", async () => {
    const fixture = reader(true, false);
    await expect(guardDepositEdit(fixture.client, "deposit")).rejects.toThrow("BANKING_DEPOSIT_ACCOUNTING_REVERSAL_REQUIRED");
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });
  it("allows operational edit after reversal on an open day, and still respects a closed day", async () => {
    await expect(guardDepositEdit(reader(false, false).client, "deposit")).resolves.toBeUndefined();
    await expect(guardDepositEdit(reader(false, true).client, "deposit")).rejects.toThrow("BANKING_DEPOSIT_REOPEN_REQUIRED");
  });
  it("freezes account setup against recorded history; an unposted account stays configurable", async () => {
    await expect(requireUnpostedBankAccount(reader(true, false).client, "account")).rejects.toThrow("BANKING_ACCOUNTING_SETUP_FROZEN");
    await expect(requireUnpostedBankAccount(reader(false, false).client, "account")).resolves.toBeUndefined();
  });
});

describe("feed evidence cannot release a posted direct receipt", () => {
  function context(mode: "match" | "deposit"): ReviewContext {
    const review = { id: "review", transaction_id: "tx", revision: 1, source_version: 1,
      status: "confirmed", mode, matched_payment_id: mode === "match" ? "cpay" : null,
      matched_deposit_id: mode === "deposit" ? "deposit" : null } as Review;
    return { tx: { id: "tx", source_version: 1 } as ReviewContext["tx"], review };
  }
  function fixture(directPosted: boolean, result: Review) {
    const queries: string[] = [];
    const client = { query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM bank_opening_clear claim")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM bank_journal_entry entry")) return { rows: directPosted ? [{ id: "posted" }] : [], rowCount: directPosted ? 1 : 0 };
      if (sql.includes("SELECT COUNT(*)")) return { rows: [{ count: "0" }] };
      if (sql.includes("INSERT INTO bank_transaction_review")) return { rows: [result] };
      if (sql.includes("INSERT INTO bank_review_event")) return { rows: [] };
      throw new Error(`Unexpected review query: ${sql}`);
    } } as unknown as PoolClient;
    return { client, queries };
  }
  test.each<Partial<Review>>([
    { matched_payment_id: null }, { matched_payment_id: "another" }, { mode: "categorize" }, { status: "excluded" },
  ])("requires reversal before changing posted Match identity: %j", async changes => {
    const ctx = context("match");
    const db = fixture(true, { ...ctx.review!, ...changes });
    await expect(persistReview(db.client, ctx, changes, "actor", "test")).rejects.toThrow("BANKING_MATCH_ACCOUNTING_REVERSAL_REQUIRED");
    expect(db.queries.some(sql => sql.includes("INSERT INTO"))).toBe(false);
  });
  it("allows the same identity change after reversal", async () => {
    const ctx = context("match");
    const next = { ...ctx.review!, matched_payment_id: null };
    const db = fixture(false, next);
    await expect(persistReview(db.client, ctx, { matched_payment_id: null }, "actor", "return")).resolves.toEqual(next);
    expect(db.queries.some(sql => sql.includes("INSERT INTO bank_transaction_review"))).toBe(true);
  });
  it("allows grouped-deposit unmatch without writing or releasing any journal/consumption", async () => {
    const ctx = context("deposit");
    const next = { ...ctx.review!, matched_deposit_id: null };
    const db = fixture(false, next);
    await expect(persistReview(db.client, ctx, { matched_deposit_id: null }, "actor", "return")).resolves.toEqual(next);
    expect(db.queries.some(sql => /(?:UPDATE|DELETE|INSERT INTO) bank_(?:journal|receipt)/.test(sql))).toBe(false);
    expect(db.queries.some(sql => sql.includes("INSERT INTO bank_transaction_review"))).toBe(true);
  });
});
