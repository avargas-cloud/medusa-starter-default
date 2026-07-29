import {
  CREDIT_MEMO_MUTATION_STEPS,
  INVOICE_MUTATION_STEPS,
  PAYMENT_MUTATION_STEPS,
  QUIESCENCE_MAX_WAIT_MS,
  describeBlockers,
  hasWaitedTooLong,
  isLiveOperation,
  findApplyPaymentBlockers,
  type PipelineOperationRow,
} from "../../lib/quickbooks/pipeline/document-quiescence";

/**
 * Regression guard for the CM-1105 / Invoice 21215 incident (2026-07-27).
 *
 * An operator edited a credit memo that was already in QuickBooks. While the
 * corrective `credit_memo_mod` was still in flight, an `apply_payment` fired
 * against that same credit memo and QuickBooks rejected it with Error 3210.
 * Two minutes later the mod landed and the very same apply would have worked.
 *
 * The dependency gates only ever asked "does the document EXIST in QB yet?".
 * They never asked "is the document QUIESCENT?" — these tests lock in the
 * second question.
 */
const row = (over: Partial<PipelineOperationRow>): PipelineOperationRow => ({
  id: "row-1",
  step: "credit_memo_mod",
  status: "pending",
  reference_id: "cm-1",
  medusa_ref_number: "CM-1105",
  next_retry_at: null,
  ...over,
});

describe("isLiveOperation", () => {
  it.each(["waiting", "pending", "processing", "submitted"])(
    "treats %s as live (the document may still change)",
    (status) => {
      expect(isLiveOperation(row({ status }))).toBe(true);
    }
  );

  it.each(["confirmed", "fixed", "skipped"])(
    "treats %s as settled",
    (status) => {
      expect(isLiveOperation(row({ status }))).toBe(false);
    }
  );

  it("treats a failed row with a scheduled retry as live", () => {
    expect(
      isLiveOperation(
        row({ status: "failed", next_retry_at: new Date("2030-01-01") })
      )
    ).toBe(true);
  });

  it("treats a failed row with no scheduled retry as settled", () => {
    // Terminal. It must not block the apply forever — it surfaces in the UI
    // and the digest on its own.
    expect(
      isLiveOperation(row({ status: "failed", next_retry_at: null }))
    ).toBe(false);
  });
});

describe("mutation step families", () => {
  it("covers every step that can change a credit memo in QB", () => {
    expect(CREDIT_MEMO_MUTATION_STEPS).toEqual(
      expect.arrayContaining([
        "credit_memo",
        "credit_memo_mod",
        "void_credit_memo",
      ])
    );
  });

  it("covers every step that can change an invoice or sales receipt in QB", () => {
    expect(INVOICE_MUTATION_STEPS).toEqual(
      expect.arrayContaining([
        "invoice",
        "invoice_update",
        "void_invoice",
        "sales_receipt",
        "sales_receipt_update",
        "void_sales_receipt",
      ])
    );
  });

  it("covers every step that can change a ReceivePayment in QB", () => {
    expect(PAYMENT_MUTATION_STEPS).toEqual(
      expect.arrayContaining([
        "payment",
        "payment_method_change",
        "payment_txndate_change",
        "transfer_payment",
      ])
    );
  });

  it("never lists apply_payment itself — an apply must not block an apply", () => {
    for (const family of [
      CREDIT_MEMO_MUTATION_STEPS,
      INVOICE_MUTATION_STEPS,
      PAYMENT_MUTATION_STEPS,
    ]) {
      expect(family).not.toContain("apply_payment");
    }
  });
});

describe("findApplyPaymentBlockers", () => {
  const fakePool = (rows: PipelineOperationRow[]) => ({
    calls: [] as { sql: string; params: unknown[] }[],
    async query(sql: string, params: unknown[] = []) {
      this.calls.push({ sql, params });
      return { rows };
    },
  });

  it("reports the in-flight credit memo mod that caused the incident", async () => {
    const pool = fakePool([
      row({
        id: "cm-mod-row",
        step: "credit_memo_mod",
        status: "pending",
        medusa_ref_number: "CM-1105",
      }),
    ]);
    const blockers = await findApplyPaymentBlockers(pool, {
      invoiceId: "inv-1",
      creditMemoNumber: "CM-1105",
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0].step).toBe("credit_memo_mod");
  });

  it("returns nothing when every operation on both documents has settled", async () => {
    const pool = fakePool([
      row({ id: "a", step: "credit_memo", status: "confirmed" }),
      row({ id: "b", step: "invoice", status: "confirmed" }),
      row({ id: "c", step: "credit_memo_mod", status: "skipped" }),
    ]);
    const blockers = await findApplyPaymentBlockers(pool, {
      invoiceId: "inv-1",
      creditMemoNumber: "CM-1105",
    });
    expect(blockers).toEqual([]);
  });

  it("never blocks on the apply row being dispatched", async () => {
    const pool = fakePool([
      row({ id: "self", step: "apply_payment", status: "processing" }),
    ]);
    const blockers = await findApplyPaymentBlockers(pool, {
      invoiceId: "inv-1",
      creditMemoNumber: "CM-1105",
      excludeRowId: "self",
    });
    expect(blockers).toEqual([]);
  });

  it("queries the payment document family for non credit-memo payments", async () => {
    const pool = fakePool([]);
    await findApplyPaymentBlockers(pool, {
      invoiceId: "inv-1",
      paymentId: "cpay_1",
    });
    const params = pool.calls[0].params.flat();
    for (const step of PAYMENT_MUTATION_STEPS) {
      expect(params).toContain(step);
    }
  });

  it("always scopes the query to the target invoice", async () => {
    const pool = fakePool([]);
    await findApplyPaymentBlockers(pool, {
      invoiceId: "inv-42",
      creditMemoNumber: "CM-1105",
    });
    expect(pool.calls[0].params.flat()).toContain("inv-42");
  });
});

describe("hasWaitedTooLong (escape hatch)", () => {
  const now = new Date("2026-07-27T17:00:00Z");

  it("keeps waiting inside the window", () => {
    const since = new Date(now.getTime() - 60_000);
    expect(hasWaitedTooLong(since, now)).toBe(false);
  });

  it("gives up once the window is exceeded", () => {
    const since = new Date(now.getTime() - QUIESCENCE_MAX_WAIT_MS - 1);
    expect(hasWaitedTooLong(since, now)).toBe(true);
  });

  it("treats a first deferral (no timestamp yet) as inside the window", () => {
    expect(hasWaitedTooLong(null, now)).toBe(false);
  });

  it("accepts an ISO string as stored in the jsonb payload", () => {
    const since = new Date(now.getTime() - QUIESCENCE_MAX_WAIT_MS - 1000);
    expect(hasWaitedTooLong(since.toISOString(), now)).toBe(true);
  });

  it("ignores an unparseable timestamp rather than waiting forever", () => {
    expect(hasWaitedTooLong("not-a-date", now)).toBe(true);
  });
});

describe("describeBlockers", () => {
  it("renders an operator-readable reason", () => {
    expect(
      describeBlockers([
        {
          id: "x",
          step: "credit_memo_mod",
          status: "pending",
          reference: "CM-1105",
        },
      ])
    ).toBe("credit_memo_mod (CM-1105) [pending]");
  });

  it("omits the reference when the row has none", () => {
    expect(
      describeBlockers([
        { id: "x", step: "invoice_update", status: "submitted", reference: null },
      ])
    ).toBe("invoice_update [submitted]");
  });
});
