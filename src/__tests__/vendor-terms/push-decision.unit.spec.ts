import {
  decideVendorPush,
  QB_RELEVANT_FIELDS,
  syncStampForOutcome,
  termChanged,
  toVendorSnapshot,
} from "../../lib/vendor-terms/push";

const BEFORE = {
  id: "qbvnd_1",
  qb_list_id: "80000A1B-1234567890",
  name: "Shenzhen Lighting Co",
  terms_ref_name: "Net-30",
  email: "ap@example.com",
  credit_limit: 5000,
  city: "Miami",
  is_vendor_eligible_for_1099: false,
};

describe("decideVendorPush", () => {
  it("pushes when the payment term moves", () => {
    const d = decideVendorPush(BEFORE, { terms_ref_name: "Net-60" });
    expect(d).toMatchObject({ push: true, reason: "changed" });
    expect(d.changed).toEqual(["terms_ref_name"]);
  });

  it("does NOT push when the save re-sends the same values", () => {
    // A save is not a change. Firing a bridge round trip on every save would
    // bury the real failures in noise.
    expect(
      decideVendorPush(BEFORE, {
        terms_ref_name: "Net-30",
        email: "ap@example.com",
        credit_limit: 5000,
      })
    ).toMatchObject({ push: false, reason: "no_qb_relevant_change" });
  });

  it("compares loosely enough to survive Postgres string/number round trips", () => {
    // credit_limit comes back as a string often enough that a strict compare
    // would push on every single save.
    expect(
      decideVendorPush(BEFORE, { credit_limit: "5000" })
    ).toMatchObject({ push: false });
    expect(
      decideVendorPush(BEFORE, { is_vendor_eligible_for_1099: false })
    ).toMatchObject({ push: false });
    expect(decideVendorPush(BEFORE, { terms_ref_name: " Net-30 " })).toMatchObject(
      { push: false }
    );
  });

  it("treats null and empty string as the same absence", () => {
    expect(
      decideVendorPush({ ...BEFORE, fax: null }, { fax: "" })
    ).toMatchObject({ push: false });
    expect(
      decideVendorPush({ ...BEFORE, fax: "" }, { fax: null })
    ).toMatchObject({ push: false });
  });

  it("ignores fields QuickBooks does not carry", () => {
    // metadata, sync bookkeeping, our own ids — none of these are QB's business.
    expect(
      decideVendorPush(BEFORE, {
        metadata: { production_days: 45 },
        prefill_account_ref_name: "COGS",
        sync_status: "waiting",
      })
    ).toMatchObject({ push: false, reason: "no_qb_relevant_change" });
  });

  it("refuses to Mod a vendor that was never created in QuickBooks", () => {
    // A pending_ placeholder means the VendorAdd never landed; a Mod against it
    // is a guaranteed rejection, so this is not a push we should attempt.
    expect(
      decideVendorPush(
        { ...BEFORE, qb_list_id: "pending_abc" },
        { terms_ref_name: "Net-60" }
      )
    ).toMatchObject({ push: false, reason: "never_synced" });
  });

  it("refuses when there is no ListID at all", () => {
    expect(
      decideVendorPush(
        { ...BEFORE, qb_list_id: null },
        { terms_ref_name: "Net-60" }
      )
    ).toMatchObject({ push: false, reason: "missing_list_id" });
  });

  it("reports every QB-relevant field that moved, not just the term", () => {
    const d = decideVendorPush(BEFORE, {
      terms_ref_name: "Net-60",
      email: "new@example.com",
      city: "Doral",
    });
    expect(d.push).toBe(true);
    expect([...d.changed].sort()).toEqual(["city", "email", "terms_ref_name"]);
  });

  it("every listed field is one the snapshot mapper actually reads", () => {
    // QB_RELEVANT_FIELDS feeds query.graph, so a name that is not a real column
    // fails the whole read. This keeps the two in step.
    const snapshot = toVendorSnapshot({
      ...BEFORE,
      ...Object.fromEntries(QB_RELEVANT_FIELDS.map((f) => [f, "x"])),
      qb_list_id: "80000A1B",
      credit_limit: 1,
    });
    expect(snapshot.qb_list_id).toBe("80000A1B");
    expect(QB_RELEVANT_FIELDS).not.toContain("name_on_check");
    expect(QB_RELEVANT_FIELDS).toContain("terms_ref_name");
  });
});

describe("termChanged", () => {
  it("is insensitive to case and whitespace", () => {
    expect(termChanged(BEFORE, { terms_ref_name: "  net-30 " })).toBe(false);
  });

  it("still distinguishes Net 30 from Net-30", () => {
    // Two distinct live terms in the company file — punctuation is meaningful.
    expect(termChanged(BEFORE, { terms_ref_name: "Net 30" })).toBe(true);
  });

  it("detects setting and clearing a term", () => {
    expect(termChanged({ terms_ref_name: null }, { terms_ref_name: "Net-30" })).toBe(
      true
    );
    expect(termChanged(BEFORE, { terms_ref_name: null })).toBe(true);
    expect(termChanged({ terms_ref_name: null }, { terms_ref_name: null })).toBe(
      false
    );
  });

  it("is false when the payload does not mention the term at all", () => {
    expect(termChanged(BEFORE, { email: "x@y.com" })).toBe(false);
  });
});

describe("syncStampForOutcome", () => {
  it("CLEARS a stale error on success", () => {
    // An old error sitting next to a healthy status teaches the operator that
    // the field lies.
    expect(syncStampForOutcome({ ok: true })).toEqual({
      sync_status: "synced",
      last_error: null,
    });
  });

  it("records the code and message QuickBooks actually returned", () => {
    const stamp = syncStampForOutcome({
      ok: false,
      statusCode: "3120",
      statusMessage: "Object specified in the request cannot be found.",
    });
    expect(stamp.sync_status).toBe("error");
    expect(stamp.last_error).toContain("3120");
    expect(stamp.last_error).toContain("cannot be found");
  });

  it("never leaves an empty error message", () => {
    const stamp = syncStampForOutcome({
      ok: false,
      statusCode: null,
      statusMessage: "",
    });
    expect(stamp.last_error).toContain("no message returned");
  });
});

describe("toVendorSnapshot", () => {
  it("maps a qb_vendor row onto the Mod's shape", () => {
    const s = toVendorSnapshot({
      ...BEFORE,
      addr1: "1 Main St",
      state: "FL",
      postal_code: "33101",
    });
    expect(s).toMatchObject({
      qb_list_id: "80000A1B-1234567890",
      name: "Shenzhen Lighting Co",
      terms_ref_name: "Net-30",
      credit_limit: 5000,
      is_vendor_eligible_for_1099: false,
    });
    expect(s.address).toMatchObject({ Addr1: "1 Main St", City: "Miami" });
  });

  it("omits the address entirely when there is none", () => {
    expect(
      toVendorSnapshot({ ...BEFORE, city: null, addr1: null, state: null }).address
    ).toBeNull();
  });

  it("falls back to full_name when name is missing", () => {
    expect(
      toVendorSnapshot({ qb_list_id: "X", full_name: "Acme Ltd" }).name
    ).toBe("Acme Ltd");
  });

  it("turns blanks into nulls so the builder omits them", () => {
    const s = toVendorSnapshot({ ...BEFORE, email: "   ", fax: "" });
    expect(s.email).toBeNull();
    expect(s.fax).toBeNull();
  });
});
