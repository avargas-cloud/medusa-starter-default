import {
  ADD_CAPABLE_STEPS,
  PIPELINE_VERDICT_PATTERNS,
  evaluateRetryGate,
  type RetryGateInput,
} from "../../lib/quickbooks/pipeline/retry-gate";

/**
 * Guards the admin Retry button (`post-pipeline.ts`) against re-dispatching an
 * ADD step that may already have landed in QuickBooks. Delegating everything to
 * `decideAddRetrySafety` would block legitimate retries at volume — see the
 * `sales_order`/`apply_payment` cases below, which are pipeline verdicts, not
 * QuickBooks failures.
 */
describe("evaluateRetryGate", () => {
  const base: RetryGateInput = {
    step: "invoice",
    status: "failed",
    error: null,
    bridgeOpId: null,
    qbTxnId: null,
  };

  // --- Branch 1: step not ADD-capable -------------------------------------

  it("branch 1: allows a non-ADD-capable step (78 real rows today: vendor_bill_payment_check)", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "vendor_bill_payment_check",
      status: "failed",
      bridgeOpId: "op_123",
    });
    expect(verdict.allow).toBe(true);
  });

  it("branch 1: allows an unknown/made-up step (not in ADD_CAPABLE_STEPS)", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "algo_que_no_existe",
      bridgeOpId: "op_123",
    });
    expect(verdict.allow).toBe(true);
  });

  it("ADD_CAPABLE_STEPS contains exactly the 12 specified steps", () => {
    expect([...ADD_CAPABLE_STEPS].sort()).toEqual(
      [
        "estimate",
        "sales_order",
        "invoice",
        "sales_receipt",
        "credit_memo",
        "payment",
        "apply_payment",
        "write_check",
        "item_receipt_add",
        "commission_check",
        "commission_payment",
        "vendor_bill_add",
      ].sort()
    );
  });

  // --- Branch 2: pipeline verdict, not a failure --------------------------

  it("branch 2: allows sales_order superseded-by-invoice (1337 real rows)", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "sales_order",
      error: "Superseded by Invoice/Sales Receipt — Sales Order not needed",
      bridgeOpId: "op_456",
    });
    expect(verdict.allow).toBe(true);
  });

  it("branch 2: allows apply_payment voided-application (58 real rows)", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "apply_payment",
      error:
        "apply_payment: payment_application voided (invoice INV-20959 voided)",
      bridgeOpId: "op_789",
    });
    expect(verdict.allow).toBe(true);
  });

  it("branch 2: a bare keyword is NOT enough to match — patterns are anchored to our own sentences", () => {
    // This test used to assert the opposite (that each of these bare words
    // matched), which is what made the branch a colander: it runs before the
    // classifier, so any word it matches skips the outcome-unknown check. The
    // property worth locking down is that a lone word does NOT match, while the
    // full sentence our code actually writes DOES.
    const bareWords = ["superseded", "voided", "skipped", "already", "no longer"];
    for (const word of bareWords) {
      expect(PIPELINE_VERDICT_PATTERNS.some((rx) => rx.test(word))).toBe(false);
    }

    const realSentences = [
      "Superseded by Invoice/Sales Receipt — Sales Order not needed",
      "apply_payment: payment_application voided (nothing to apply) — auto-skipped",
      "Order canceled before sales_order reached QuickBooks",
      "Invoice permanently skipped — replaced by Sales Receipt",
      "Order reverted to draft — Sales Order superseded",
    ];
    for (const sentence of realSentences) {
      expect(PIPELINE_VERDICT_PATTERNS.some((rx) => rx.test(sentence))).toBe(true);
    }
  });

  it("branch 2 wins over branch 5 when a row matches both (order matters)", () => {
    // sales_order + "Superseded" + bridgeOpId present should resolve via
    // branch 2 (allow), never fall through to branch 5 (which would deny
    // without a qbTxnId, since this error is not a recognised QB-answered one).
    const verdict = evaluateRetryGate({
      ...base,
      step: "sales_order",
      error: "Superseded by Invoice/Sales Receipt — Sales Order not needed",
      bridgeOpId: "op_456",
      qbTxnId: null,
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toMatch(/pipeline verdict/i);
  });

  // --- Branch 3: ADD-capable + qbTxnId present ----------------------------

  it("branch 3: allows invoice with qbTxnId present even with a bridge timeout error", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "invoice",
      error: "Timed out before submitted state (>20 min) — no response from QB bridge",
      bridgeOpId: "op_999",
      qbTxnId: "5555-1234567890",
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toMatch(/MOD/i);
  });

  // --- Branch 4: ADD-capable + no bridgeOpId ------------------------------

  it("branch 4: allows credit_memo with no bridgeOpId even with a timeout error", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "credit_memo",
      error: "Timed out before submitted state (>20 min) — no response from QB bridge",
      bridgeOpId: null,
      qbTxnId: null,
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toMatch(/never reached the bridge/i);
  });

  // --- Branch 5: ADD-capable + bridgeOpId -> decideAddRetrySafety --------

  it("branch 5: DENIES credit_memo with bridgeOpId + canonical timeout (outcome unknown)", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "credit_memo",
      error: "Timed out before submitted state (>20 min) — no response from QB bridge",
      bridgeOpId: "op_111",
      qbTxnId: null,
    });
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) {
      expect(verdict.code).toBe("retry_needs_qb_verification");
      expect(verdict.instructions).toMatch(/EntityFilter/);
      expect(verdict.instructions).toMatch(/RefNumber/);
    }
  });

  it("branch 5: allows write_check when QuickBooks answered with an error code", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "write_check",
      error: "QuickBooks Error 3200: The name already exists.",
      bridgeOpId: "op_222",
      qbTxnId: null,
    });
    expect(verdict.allow).toBe(true);
  });

  it("fail-closed: DENIES payment with bridgeOpId present and no error detail", () => {
    const verdict = evaluateRetryGate({
      ...base,
      step: "payment",
      error: null,
      bridgeOpId: "op_333",
      qbTxnId: null,
    });
    expect(verdict.allow).toBe(false);
    if (!verdict.allow) {
      expect(verdict.code).toBe("retry_needs_qb_verification");
    }
  });

  // --- Branch 2 must be ANCHORED, not keyword-based -------------------------
  //
  // Branch 2 runs BEFORE branch 5, so whatever it matches never reaches
  // `decideAddRetrySafety`. A first cut used bare /already/i, /voided/i and
  // /skipped/i — ordinary English in error text — which waved genuine
  // outcome-unknown failures straight through. These are the regression tests
  // for that hole: each string below is an outcome-unknown failure that happens
  // to contain a word the loose patterns matched.

  const OUTCOME_UNKNOWN_TRAPS: readonly string[] = [
    // Contains "already" — the sharpest case: it reads like a verdict and isn't.
    "The operation may have already completed but no response was received",
    // Contains "skipped".
    "QBWC skipped the session; no response from QuickBooks",
    // Contains "voided".
    "Timed out while checking whether the document was voided — no response",
    // The literal message runTimeoutPass writes, which add-retry-safety's regex
    // recognises via "before submitted state".
    "Timed out before submitted state (>20 min) — no response from QB bridge",
    "QuickBooks aborted the session: 0x8004041C",
    "Operation completed but no TxnID in response",
  ];

  it.each(OUTCOME_UNKNOWN_TRAPS)(
    "branch 2 does NOT swallow an outcome-unknown failure: %s",
    (error) => {
      const verdict = evaluateRetryGate({
        ...base,
        step: "credit_memo",
        error,
        bridgeOpId: "op_real",
      });
      expect(verdict.allow).toBe(false);
      if (!verdict.allow) {
        expect(verdict.code).toBe("retry_needs_qb_verification");
      }
    }
  );

  it("no PIPELINE_VERDICT_PATTERN matches a bare outcome-unknown keyword", () => {
    // Asserts the property directly on the exported list, so a future edit that
    // re-introduces a loose keyword fails here even if no branch test covers it.
    for (const trap of OUTCOME_UNKNOWN_TRAPS) {
      const hit = PIPELINE_VERDICT_PATTERNS.find((rx) => rx.test(trap));
      expect(hit).toBeUndefined();
    }
  });

  // The real pipeline verdicts, at volume, MUST stay allowed — censused from
  // production (`status='skipped'`, ADD-capable steps).
  const REAL_PIPELINE_VERDICTS: readonly string[] = [
    "Superseded by Invoice/Sales Receipt — Sales Order not needed", // 1308 rows
    "Superseded by Sales Receipt — payment embedded in SR", //  658 rows
    "Converted to Sales Order — Estimate not needed", //  193 rows
    "apply_payment: superseded by payment_application (papp_) sibling row", //   35 rows
    "Order canceled before sales_order reached QuickBooks", //   16 rows
    "A3 cleanup: duplicate cpay_-keyed apply_payment superseded by canonical papp_ row", //   12 rows
    "Invoice permanently skipped — replaced by Sales Receipt (manual fix 2026-04-30)",
    "Order reverted to draft — Sales Order superseded",
    "apply_payment: payment_application voided (nothing to apply) — auto-skipped",
  ];

  it.each(REAL_PIPELINE_VERDICTS)(
    "branch 2 keeps a real pipeline verdict retryable: %s",
    (error) => {
      const verdict = evaluateRetryGate({
        ...base,
        step: "sales_order",
        error,
        bridgeOpId: "op_real",
      });
      expect(verdict.allow).toBe(true);
    }
  );

  it("ADD_CAPABLE_STEPS covers exactly the 12 steps whose Add mints a document", () => {
    expect([...ADD_CAPABLE_STEPS].sort()).toEqual(
      [
        "apply_payment",
        "credit_memo",
        "estimate",
        "invoice",
        "item_receipt_add",
        "commission_check",
        "commission_payment",
        "payment",
        "sales_order",
        "sales_receipt",
        "vendor_bill_add",
        "write_check",
      ].sort()
    );
  });
});
