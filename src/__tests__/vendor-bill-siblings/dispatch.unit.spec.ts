/**
 * decideSecondaryDispatch — the rule that says WHEN a service / freight /
 * tariff bill may be written to QuickBooks.
 *
 * Pure, so it is tested with real cases rather than mocks. It authorises money
 * reaching A/P, and its previous absence cost 18 bills a month of silence.
 *
 * The distinction every case below is really about: DEFERRED (waiting, healthy)
 * versus NOT DISPATCHED (someone else's job) versus should-have-gone. Collapsing
 * "waiting" and "lost" into one indistinguishable state is the original bug.
 */

import {
  decideSecondaryDispatch,
  fatalSiblingOutcomes,
  parentDocumentIsLive,
  REGULAR_GREEN_LIGHT_STATUSES,
  REGULAR_LIVE_DOCUMENT_STATUSES,
  SECONDARY_SENDABLE_STATUSES,
  type ParentRegularFacts,
  type SecondaryDispatchFacts,
  type SiblingDispatchOutcome,
} from "../../lib/purchase-orders/qb-vendor-bill-sibling-dispatch";

const facts = (over: Partial<SecondaryDispatchFacts> = {}): SecondaryDispatchFacts => ({
  bill_type: "freight",
  has_purchase_order: true,
  parent_regular: null,
  already_in_quickbooks: false,
  ...over,
});

/**
 * A parent that is NOT in QuickBooks by default. The interesting cases are the
 * ones that flip it on, so the default has to be the quiet one — a helper that
 * defaulted to `true` would make half these tests pass for the wrong reason.
 */
const parent = (over: Partial<ParentRegularFacts> = {}): ParentRegularFacts => ({
  vendor_bill_id: "vb_1",
  number: "VB-1139",
  status: "draft",
  already_in_quickbooks: false,
  ...over,
});

describe("decideSecondaryDispatch", () => {
  it("never dispatches a regular bill — it dispatches itself", () => {
    const d = decideSecondaryDispatch(facts({ bill_type: "regular" }));
    expect(d.dispatch).toBe(false);
    // NOT deferred: nothing is waiting on anything. A regular reported as
    // deferred would show up in the verifier as a bill waiting forever.
    expect(d).toMatchObject({ dispatch: false, deferred: false });
  });

  it("never re-adds a bill already in QuickBooks (that is the Mod path)", () => {
    const d = decideSecondaryDispatch(facts({ already_in_quickbooks: true }));
    expect(d).toMatchObject({ dispatch: false, deferred: false });
  });

  it("dispatches a bill with NO purchase order immediately", () => {
    // The owner's case: a standalone sales commission (VB-1132 CPS CABINETS,
    // VB-1133 AAF ELECTRICAL). No regular bill can ever point at it, so there
    // is no pair to complete — confirming it IS the green light.
    const d = decideSecondaryDispatch(
      facts({ bill_type: "service", has_purchase_order: false })
    );
    expect(d.dispatch).toBe(true);
  });

  it("still dispatches a no-PO bill even when nothing links it", () => {
    const d = decideSecondaryDispatch(
      facts({ has_purchase_order: false, parent_regular: null })
    );
    expect(d.dispatch).toBe(true);
  });

  it("defers when the bill has a PO but no regular links it yet", () => {
    const d = decideSecondaryDispatch(facts({ parent_regular: null }));
    expect(d).toMatchObject({ dispatch: false, deferred: true });
  });

  it("defers while the regular bill is still a draft", () => {
    const d = decideSecondaryDispatch(
      facts({
        parent_regular: parent({ number: "VB-1139", status: "draft" }),
      })
    );
    expect(d).toMatchObject({ dispatch: false, deferred: true });
    // The operator has to be able to act on this without opening the PO.
    expect(d.reason).toContain("VB-1139");
  });

  it.each(["confirmed", "synced"])(
    "dispatches once the regular bill is '%s' — the green light is already given",
    (status) => {
      const d = decideSecondaryDispatch(
        facts({
          parent_regular: parent({ number: "VB-1070", status }),
        })
      );
      expect(d.dispatch).toBe(true);
      expect(d.reason).toContain("VB-1070");
    }
  );

  it.each(["cancelled", "voided", "deleted"])(
    "does NOT treat a '%s' regular bill as a green light",
    (status) => {
      // That group's QuickBooks document is gone or was never meant to exist;
      // posting a sibling against it leaves a charge with no counterpart. It
      // stays deferred and the verifier reports it, rather than this module
      // inventing a behaviour nobody specified.
      const d = decideSecondaryDispatch(
        facts({
          parent_regular: parent({ number: "VB-9", status }),
        })
      );
      expect(d).toMatchObject({ dispatch: false, deferred: true });
    }
  );

  it("falls back to the bill id when the regular has no number yet", () => {
    const d = decideSecondaryDispatch(
      facts({
        parent_regular: parent({ vendor_bill_id: "vb_abc", number: null, status: "draft" }),
      })
    );
    expect(d.reason).toContain("vb_abc");
  });

  it("checks already-in-QuickBooks BEFORE the pair rule", () => {
    // A sibling that lives in QuickBooks while its regular is still a draft
    // must not be reported as deferred: it is done, not waiting.
    const d = decideSecondaryDispatch(
      facts({
        already_in_quickbooks: true,
        parent_regular: parent({ number: "VB-1139", status: "draft" }),
      })
    );
    expect(d).toMatchObject({ dispatch: false, deferred: false });
  });

  // ── the regular is a DRAFT but its QuickBooks Bill exists (2026-09-03) ──
  //
  // The production case: VB-1128 went back to `draft` for a revision while its
  // Bill stayed in QuickBooks, subtracting VB-1129 ($380.68) and VB-1130
  // ($585.00) through clearing lines. Both read as healthily "waiting" for a
  // month. The status is not the document.

  it("dispatches when the regular is a draft whose Bill ALREADY lives in QuickBooks", () => {
    const d = decideSecondaryDispatch(
      facts({
        parent_regular: parent({
          number: "VB-1128",
          status: "draft",
          already_in_quickbooks: true,
        }),
      })
    );
    expect(d.dispatch).toBe(true);
    // The reason has to name the bill AND say why, or the operator reading the
    // verifier cannot tell this apart from the ordinary confirmed case.
    expect(d.reason).toContain("VB-1128");
    expect(d.reason).toContain("QuickBooks");
  });

  it("still defers a draft regular that has never reached QuickBooks", () => {
    // The other half, and the reason this is not just "draft is green now":
    // VB-1139's group is genuinely virgin, so its siblings are correctly
    // waiting and must NOT be dispatched.
    const d = decideSecondaryDispatch(
      facts({
        parent_regular: parent({
          number: "VB-1139",
          status: "draft",
          already_in_quickbooks: false,
        }),
      })
    );
    expect(d).toMatchObject({ dispatch: false, deferred: true });
  });

  it.each(["cancelled", "voided", "deleted"])(
    "does NOT greenlight on a '%s' regular even when it kept a TxnID",
    (status) => {
      // A TxnID on a killed bill points at a document that is gone. Posting a
      // charge against it leaves it with no counterpart — worse than waiting.
      const d = decideSecondaryDispatch(
        facts({
          parent_regular: parent({
            number: "VB-9",
            status,
            already_in_quickbooks: true,
          }),
        })
      );
      expect(d).toMatchObject({ dispatch: false, deferred: true });
    }
  );
});

describe("parentDocumentIsLive", () => {
  it("needs BOTH the TxnID and a live status", () => {
    expect(
      parentDocumentIsLive(parent({ status: "draft", already_in_quickbooks: true }))
    ).toBe(true);
    expect(
      parentDocumentIsLive(parent({ status: "draft", already_in_quickbooks: false }))
    ).toBe(false);
    expect(
      parentDocumentIsLive(parent({ status: "voided", already_in_quickbooks: true }))
    ).toBe(false);
  });

  it("fails CLOSED on a status nobody has thought of yet", () => {
    // An allow-list, not a deny-list: a status added later must not silently
    // authorise money into A/P because it forgot to add itself to a blocklist.
    expect(
      parentDocumentIsLive(
        parent({ status: "some_future_status", already_in_quickbooks: true })
      )
    ).toBe(false);
  });
});

describe("the status sets", () => {
  it("treats confirmed and synced as green light, nothing else", () => {
    expect([...REGULAR_GREEN_LIGHT_STATUSES].sort()).toEqual(["confirmed", "synced"]);
    expect(REGULAR_GREEN_LIGHT_STATUSES.has("draft")).toBe(false);
  });

  it("counts draft among the LIVE document statuses — and nothing dead", () => {
    expect([...REGULAR_LIVE_DOCUMENT_STATUSES].sort()).toEqual([
      "confirmed",
      "draft",
      "synced",
    ]);
    expect(REGULAR_LIVE_DOCUMENT_STATUSES.has("voided")).toBe(false);
    expect(REGULAR_LIVE_DOCUMENT_STATUSES.has("cancelled")).toBe(false);
  });

  it("only sends a secondary that is itself a finished document", () => {
    expect(SECONDARY_SENDABLE_STATUSES.has("draft")).toBe(false);
    expect(SECONDARY_SENDABLE_STATUSES.has("confirmed")).toBe(true);
  });
});

describe("fatalSiblingOutcomes", () => {
  const outcome = (o: Partial<SiblingDispatchOutcome>): SiblingDispatchOutcome => ({
    vendor_bill_id: "vb_x",
    number: "VB-1",
    bill_type: "freight",
    outcome: "queued",
    reason: "queued",
    ...o,
  });

  it("raises only genuine failures, never structural skips", () => {
    const fatal = fatalSiblingOutcomes([
      outcome({ outcome: "queued" }),
      outcome({ outcome: "skipped", reason: "already in QuickBooks" }),
      outcome({ outcome: "skipped", reason: "not a finished document yet (status 'draft')" }),
      outcome({ outcome: "failed", reason: "bill has no lines to send", number: "VB-77" }),
    ]);
    expect(fatal.map((f) => f.number)).toEqual(["VB-77"]);
  });

  it("treats a pointer with no bill behind it as fatal", () => {
    // The regular is about to post a clearing line cancelling a document that
    // does not exist. Continuing would understate A/P by exactly that amount.
    const fatal = fatalSiblingOutcomes([
      outcome({ outcome: "failed", reason: "sibling not found" }),
    ]);
    expect(fatal).toHaveLength(1);
  });

  it("is empty when nothing failed", () => {
    expect(fatalSiblingOutcomes([outcome({ outcome: "skipped", reason: "x" })])).toEqual([]);
  });
});
