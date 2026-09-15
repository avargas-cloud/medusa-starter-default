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
  dispatchConfirmedSiblings,
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
  vendor_is_china_agent: false,
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

// ── a China-agent sibling is NEVER standalone (2026-09-15) ──────────────────
//
// The hole in the 2026-08-31 rule: "no purchase order → nothing to pair with →
// dispatch" was written for sales commissions. But a Veetech commission or
// freight bill is BORN without a PO — `NewIndependentBillModal` never sends
// one; the PO lands on it only when the regular bill's PATCH links it. So an
// operator who confirmed the sibling before linking it sent it to QuickBooks
// alone, 17 seconds after creating it, with the regular still a draft.
// Measured on production 2026-09-15: VB-1235/1236 (→ VB-1234 draft),
// VB-1239/1240 (→ VB-1237 draft), and VB-1143/1144 never linked at all.
//
// The vendor's agent flag is what separates the two shapes — the same flag that
// gates the regular's "ready = fully received" confirm.
describe("decideSecondaryDispatch — China-agent vendor", () => {
  it("defers an agent sibling with NO purchase order — it is not standalone, it is unlinked", () => {
    const d = decideSecondaryDispatch(
      facts({ bill_type: "service", has_purchase_order: false, vendor_is_china_agent: true })
    );
    expect(d).toMatchObject({ dispatch: false, deferred: true });
    expect(d.reason).toMatch(/regular/i);
  });

  it("defers an agent sibling with a PO but no regular pointing at it", () => {
    const d = decideSecondaryDispatch(
      facts({ has_purchase_order: true, parent_regular: null, vendor_is_china_agent: true })
    );
    expect(d).toMatchObject({ dispatch: false, deferred: true });
  });

  it("defers an agent sibling while its regular is a draft not yet in QuickBooks", () => {
    const d = decideSecondaryDispatch(
      facts({
        vendor_is_china_agent: true,
        parent_regular: parent({ number: "VB-1234", status: "draft" }),
      })
    );
    expect(d).toMatchObject({ dispatch: false, deferred: true });
    expect(d.reason).toContain("VB-1234");
  });

  it("dispatches an agent sibling once its regular is confirmed — the pair rule is unchanged", () => {
    const d = decideSecondaryDispatch(
      facts({
        vendor_is_china_agent: true,
        parent_regular: parent({ number: "VB-1150", status: "confirmed" }),
      })
    );
    expect(d.dispatch).toBe(true);
  });

  it("still dispatches a NON-agent bill with no PO — sales commissions keep going alone", () => {
    // Control: VB-1146/1148 (Commission for Sale:Referral), VB-1149
    // (Subcontractor), VB-1156/1157 (Duties:DHL) have no regular and never will.
    const d = decideSecondaryDispatch(
      facts({ bill_type: "service", has_purchase_order: false, vendor_is_china_agent: false })
    );
    expect(d.dispatch).toBe(true);
  });

  it("never re-adds an agent sibling already in QuickBooks, whatever the regular says", () => {
    // VB-1235: went alone by the old rule, stays there by owner decision
    // (2026-09-15). The regular's confirm must SKIP it and still post the
    // clearing line that cancels it — see dispatchConfirmedSiblings below.
    const d = decideSecondaryDispatch(
      facts({
        vendor_is_china_agent: true,
        already_in_quickbooks: true,
        parent_regular: parent({ number: "VB-1234", status: "draft" }),
      })
    );
    expect(d).toMatchObject({ dispatch: false, deferred: false });
  });
});

describe("dispatchConfirmedSiblings — a sibling already in QuickBooks", () => {
  /**
   * A knex stand-in that answers the three queries the function makes and
   * records which ones ran. The pipeline lookup and the enqueue must never be
   * reached for a sibling that already has a TxnID: a second BillAdd would
   * mint a duplicate Bill in QuickBooks (ADD steps are not idempotent).
   */
  function fakeKnex(state: { in_qb: boolean; status: string }) {
    const calls: string[] = [];
    return {
      calls,
      raw: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("FROM vendor_bill reg")) {
          return {
            rows: [
              {
                vendor_bill_id: "vb_sib",
                number: "VB-1235",
                bill_type: "service",
                qb_account_list_id: "acct",
                qb_account_full_name: "Commission for Purchase:Veetech Representative",
                total_cents: 56283,
              },
            ],
          };
        }
        if (sql.includes("WHERE id = ANY")) {
          return { rows: [{ id: "vb_sib", number: "VB-1235", status: state.status, in_qb: state.in_qb }] };
        }
        return { rows: [] };
      },
    };
  }

  it("skips it with 'already in QuickBooks' and never touches the pipeline", async () => {
    const knex = fakeKnex({ in_qb: true, status: "synced" });
    const outcomes = await dispatchConfirmedSiblings(knex, "vb_reg");
    expect(outcomes).toEqual([
      expect.objectContaining({
        number: "VB-1235",
        outcome: "skipped",
        reason: "already in QuickBooks",
      }),
    ]);
    expect(knex.calls.some((sql) => sql.includes("qb_vendor_bill_pipeline"))).toBe(false);
    // Structural skip, not a failure: the regular's confirm must go on and
    // post its clearing line — that is what balances the charge already there.
    expect(fatalSiblingOutcomes(outcomes)).toEqual([]);
  });
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
