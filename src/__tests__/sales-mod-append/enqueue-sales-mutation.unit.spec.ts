import {
  buildCoalescedSnapshot,
  CREATE_STEP_TO_MOD_STEP,
  isSalesModStep,
  SALES_MOD_STEPS,
} from "../../lib/quickbooks/pipeline/enqueue-sales-mutation";

describe("buildCoalescedSnapshot", () => {
  const AT = "2026-08-06T12:00:00.000Z";

  it("replaces the previous snapshot wholesale with the new one", () => {
    const prev = { items: [{ sku: "A", qty: 1 }], memo: "old" };
    const next = { items: [{ sku: "A", qty: 3 }] };
    const out = buildCoalescedSnapshot(prev, next, AT);
    expect(out.items).toEqual([{ sku: "A", qty: 3 }]);
    // full-snapshot contract: keys absent from the new snapshot are gone
    expect(out.memo).toBeUndefined();
  });

  it("an EMPTY incoming payload never erases the queued snapshot", () => {
    const prev = { items: [{ sku: "A", qty: 2 }], memo: "keep" };
    const out = buildCoalescedSnapshot(prev, {}, AT);
    expect(out.items).toEqual([{ sku: "A", qty: 2 }]);
    expect(out.memo).toBe("keep");
  });

  it("preserves qbLineOrder (3290 heal metadata) across a replace", () => {
    const prev = { items: [], qbLineOrder: ["1A-1", "1B-2"] };
    const next = { items: [{ sku: "B", qty: 1 }] };
    const out = buildCoalescedSnapshot(prev, next, AT);
    expect(out.qbLineOrder).toEqual(["1A-1", "1B-2"]);
  });

  it("the new snapshot's own qbLineOrder wins over the carried one", () => {
    const prev = { qbLineOrder: ["old"] };
    const next = { qbLineOrder: ["new"], items: [] };
    const out = buildCoalescedSnapshot(prev, next, AT);
    expect(out.qbLineOrder).toEqual(["new"]);
  });

  it("accumulates one coalesced_edits entry per absorbed edit", () => {
    const first = buildCoalescedSnapshot({ items: [1] }, { items: [2] }, AT);
    expect(first.coalesced_edits).toEqual([{ at: AT }]);
    const second = buildCoalescedSnapshot(
      first,
      { items: [3] },
      "2026-08-06T12:05:00.000Z"
    );
    expect(second.coalesced_edits).toEqual([
      { at: AT },
      { at: "2026-08-06T12:05:00.000Z" },
    ]);
  });

  it("handles a null previous payload", () => {
    const out = buildCoalescedSnapshot(null, { items: [1] }, AT);
    expect(out.items).toEqual([1]);
    expect(out.coalesced_edits).toEqual([{ at: AT }]);
  });

  it("mergePayload layers narrow keys over the queued snapshot without dropping items", () => {
    const prev = { items: [{ sku: "A", qty: 2 }], memo: "old" };
    const next = { salesRepRef: "MF", taxMode: "exempt" };
    const out = buildCoalescedSnapshot(prev, next, AT, true);
    expect(out.items).toEqual([{ sku: "A", qty: 2 }]);
    expect(out.salesRepRef).toBe("MF");
    expect(out.taxMode).toBe("exempt");
    expect(out.memo).toBe("old");
  });

  it("mergePayload still lets incoming keys win over queued ones", () => {
    const out = buildCoalescedSnapshot({ memo: "old" }, { memo: "new" }, AT, true);
    expect(out.memo).toBe("new");
  });
});

describe("sales mod step registry", () => {
  it("every create step redirect targets a registered mod step", () => {
    for (const modStep of Object.values(CREATE_STEP_TO_MOD_STEP)) {
      expect(isSalesModStep(modStep as string)).toBe(true);
    }
  });

  it("estimate and sales_order map to their new mod steps", () => {
    expect(CREATE_STEP_TO_MOD_STEP.estimate).toBe("estimate_mod");
    expect(CREATE_STEP_TO_MOD_STEP.sales_order).toBe("sales_order_mod");
  });

  it("apply_payment is NOT part of the mod lane", () => {
    expect(isSalesModStep("apply_payment")).toBe(false);
    expect((SALES_MOD_STEPS as readonly string[]).includes("apply_payment")).toBe(
      false
    );
  });
});
