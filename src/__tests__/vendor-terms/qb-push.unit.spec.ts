import {
  buildDateDrivenTermsAddQbxml,
  buildStandardTermsAddQbxml,
  isAlreadyExistsError,
  parseDirectQueryStatus,
  QB_TERMS_NAME_MAX,
} from "../../lib/quickbooks/qb-terms-add";
import {
  buildVendorEditSequenceQuery,
  buildVendorModQbxml,
  parseVendorEditSequence,
  type QbVendorSnapshot,
} from "../../lib/quickbooks/qb-vendor-mod";
import { escapeXml, qbxmlEnvelope } from "../../lib/quickbooks/qbxml-escape";

/** Order of the elements as they appear in the emitted XML. */
function elementOrder(xml: string): string[] {
  return [...xml.matchAll(/<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1]!);
}

/**
 * EVERY optional field is populated on purpose. A fixture that leaves one out
 * makes the element-order assertion vacuous for that field: an earlier version
 * of this spec omitted `vendor_type_ref_name`, so swapping VendorTypeRef and
 * TermsRef in the builder changed nothing observable and the mutation went
 * uncaught. Order is the whole reason this builder can fail catastrophically —
 * QB rejects a mis-ordered request with HRESULT 0x80040400 before reading a
 * single value — so every element must actually be emitted here.
 */
const VENDOR: QbVendorSnapshot = {
  qb_list_id: "80000A1B-1234567890",
  name: "Shenzhen Lighting Co",
  company_name: "Shenzhen Lighting Co Ltd",
  first_name: "Wei",
  middle_initial: "L",
  last_name: "Zhang",
  contact: "Wei Zhang",
  alt_contact: "Ana Ruiz",
  name_on_check: "Shenzhen Lighting Co Ltd",
  account_number: "ACCT-4471",
  notes: "Consolidates with the Guangzhou agent",
  email: "ap@example.com",
  phone: "305-555-0100",
  alt_phone: "305-555-0101",
  fax: "305-555-0102",
  tax_identity: "98-7654321",
  vendor_type_ref_name: "Overseas",
  terms_ref_name: "Net-30",
  credit_limit: 5000,
  is_vendor_eligible_for_1099: false,
  is_active: true,
  address: { Addr1: "1 Main St", City: "Miami", State: "FL", PostalCode: "33101" },
};

describe("qbxml envelope", () => {
  it("wraps the body — the raw passthrough adds nothing", () => {
    const xml = qbxmlEnvelope("<PingRq/>");
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml).toContain('<?qbxml version="10.0"?>');
    expect(xml).toContain('<QBXMLMsgsRq onError="stopOnError">');
    expect(xml).toContain("<PingRq/>");
    expect(xml.endsWith("</QBXMLMsgsRq></QBXML>")).toBe(true);
  });

  it("escapes every XML metacharacter", () => {
    expect(escapeXml(`A & B <c> "d" 'e'`)).toBe(
      "A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;"
    );
  });
});

describe("StandardTermsAdd", () => {
  it("emits Name → IsActive → StdDueDays in that exact order", () => {
    const xml = buildStandardTermsAddQbxml({ name: "Net-45", days: 45 });
    const order = elementOrder(xml).filter((e) =>
      ["Name", "IsActive", "StdDueDays"].includes(e)
    );
    expect(order).toEqual(["Name", "IsActive", "StdDueDays"]);
    expect(xml).toContain("<StdDueDays>45</StdDueDays>");
  });

  it("accepts Due on Receipt as zero days", () => {
    expect(
      buildStandardTermsAddQbxml({ name: "Due on Receipt", days: 0 })
    ).toContain("<StdDueDays>0</StdDueDays>");
  });

  it("escapes a name QuickBooks really has", () => {
    // "30% Deposit, 70% upon delivery" is a live term; ampersands appear too.
    const xml = buildStandardTermsAddQbxml({ name: "Cash & Carry", days: 0 });
    expect(xml).toContain("<Name>Cash &amp; Carry</Name>");
  });

  it.each([
    ["negative", -1],
    ["over a year", 400],
    ["fractional", 30.5],
  ])("rejects %s day counts", (_l, days) => {
    expect(() => buildStandardTermsAddQbxml({ name: "X", days })).toThrow();
  });

  it("refuses to truncate an over-long name instead of silently renaming it", () => {
    const tooLong = "N".repeat(QB_TERMS_NAME_MAX + 1);
    expect(() =>
      buildStandardTermsAddQbxml({ name: tooLong, days: 30 })
    ).toThrow(/allows 31/);
    // The boundary itself is fine.
    expect(() =>
      buildStandardTermsAddQbxml({ name: "N".repeat(QB_TERMS_NAME_MAX), days: 30 })
    ).not.toThrow();
  });

  it("rejects a blank name", () => {
    expect(() => buildStandardTermsAddQbxml({ name: "   ", days: 30 })).toThrow();
  });
});

describe("DateDrivenTermsAdd", () => {
  it("emits DueNextMonthDays even when zero — QuickBooks requires it", () => {
    const xml = buildDateDrivenTermsAddQbxml({ name: "120", dayOfMonthDue: 20 });
    expect(xml).toContain("<DueNextMonthDays>0</DueNextMonthDays>");
    const order = elementOrder(xml).filter((e) =>
      ["Name", "IsActive", "DayOfMonthDue", "DueNextMonthDays"].includes(e)
    );
    expect(order).toEqual([
      "Name",
      "IsActive",
      "DayOfMonthDue",
      "DueNextMonthDays",
    ]);
  });

  it("carries a grace window when given", () => {
    expect(
      buildDateDrivenTermsAddQbxml({
        name: "120",
        dayOfMonthDue: 20,
        dueNextMonthDays: 10,
      })
    ).toContain("<DueNextMonthDays>10</DueNextMonthDays>");
  });

  it.each([0, 32, 1.5])("rejects day-of-month %p", (dom) => {
    expect(() =>
      buildDateDrivenTermsAddQbxml({ name: "X", dayOfMonthDue: dom })
    ).toThrow();
  });
});

describe("already-exists detection", () => {
  it("treats QB 3100 as the term already being there", () => {
    expect(isAlreadyExistsError("3100", "whatever")).toBe(true);
    expect(
      isAlreadyExistsError(null, "The name “Net-45” is already in use.")
    ).toBe(true);
  });

  it("does NOT swallow unrelated rejections", () => {
    expect(isAlreadyExistsError("3120", "Object not found")).toBe(false);
    expect(isAlreadyExistsError("3000", "Insufficient permission")).toBe(false);
    expect(isAlreadyExistsError(null, "")).toBe(false);
  });
});

describe("VendorMod", () => {
  it("puts ListID and EditSequence first — QB's optimistic lock", () => {
    const xml = buildVendorModQbxml(VENDOR, "1234567890");
    const order = elementOrder(xml);
    const listIdAt = order.indexOf("ListID");
    const editSeqAt = order.indexOf("EditSequence");
    const nameAt = order.indexOf("Name");
    expect(listIdAt).toBeGreaterThanOrEqual(0);
    expect(editSeqAt).toBe(listIdAt + 1);
    expect(nameAt).toBe(editSeqAt + 1);
  });

  it("emits the SDK's strict element order, exactly", () => {
    const xml = buildVendorModQbxml(VENDOR, "abc");
    // The literal expected sequence — NOT derived from the output, or the
    // assertion proves nothing. Nested children (Addr1..., FullName) are
    // dropped so this reads as the VendorMod's own field order.
    const NESTED = new Set([
      "Addr1",
      "Addr2",
      "City",
      "State",
      "PostalCode",
      "Country",
      "FullName",
    ]);
    expect(
      elementOrder(xml).filter((e) => !NESTED.has(e) && e !== "QBXML")
    ).toEqual([
      "VendorModRq",
      "VendorMod",
      "ListID",
      "EditSequence",
      "Name",
      "IsActive",
      "CompanyName",
      "FirstName",
      "MiddleInitial",
      "LastName",
      "VendorAddress",
      "Phone",
      "AltPhone",
      "Fax",
      "Email",
      "Contact",
      "AltContact",
      "NameOnCheck",
      "AccountNumber",
      "Notes",
      "VendorTypeRef",
      "TermsRef",
      "CreditLimit",
      "VendorTaxIdent",
      "IsVendorEligibleFor1099",
    ]);
  });

  it("wraps a TermsRef in FullName, which is what QuickBooks matches on", () => {
    expect(buildVendorModQbxml(VENDOR, "abc")).toContain(
      "<TermsRef><FullName>Net-30</FullName></TermsRef>"
    );
  });

  it("omits TermsRef entirely when the vendor has no term", () => {
    const xml = buildVendorModQbxml({ ...VENDOR, terms_ref_name: null }, "abc");
    expect(xml).not.toContain("TermsRef");
  });

  it("sends the full snapshot, not just the edited field", () => {
    // The Mod must reproduce what the Add sent — omission is how BillMod
    // silently deleted data in this codebase before.
    const xml = buildVendorModQbxml(VENDOR, "abc");
    expect(xml).toContain("<CompanyName>Shenzhen Lighting Co Ltd</CompanyName>");
    expect(xml).toContain("<Email>ap@example.com</Email>");
    expect(xml).toContain("<Phone>305-555-0100</Phone>");
    expect(xml).toContain("<City>Miami</City>");
    expect(xml).toContain("<CreditLimit>5000.00</CreditLimit>");
  });

  it("formats CreditLimit with two decimals from any numeric shape", () => {
    expect(buildVendorModQbxml({ ...VENDOR, credit_limit: "2500" }, "a")).toContain(
      "<CreditLimit>2500.00</CreditLimit>"
    );
    expect(buildVendorModQbxml({ ...VENDOR, credit_limit: 0 }, "a")).toContain(
      "<CreditLimit>0.00</CreditLimit>"
    );
    expect(
      buildVendorModQbxml({ ...VENDOR, credit_limit: null }, "a")
    ).not.toContain("CreditLimit");
  });

  it("refuses a vendor that was never created in QuickBooks", () => {
    expect(() =>
      buildVendorModQbxml(
        { ...VENDOR, qb_list_id: "pending_abc123" },
        "seq"
      )
    ).toThrow(/never created in QuickBooks/);
  });

  it("refuses without a ListID or an EditSequence", () => {
    expect(() =>
      buildVendorModQbxml({ ...VENDOR, qb_list_id: "" }, "seq")
    ).toThrow(/ListID/);
    expect(() => buildVendorModQbxml(VENDOR, "  ")).toThrow(/EditSequence/);
  });

  it("escapes a vendor name containing XML metacharacters", () => {
    const xml = buildVendorModQbxml(
      { ...VENDOR, name: "Smith & Sons <Lighting>" },
      "abc"
    );
    expect(xml).toContain("<Name>Smith &amp; Sons &lt;Lighting&gt;</Name>");
  });

  it("truncates to QuickBooks' field limits rather than being rejected", () => {
    const xml = buildVendorModQbxml(
      { ...VENDOR, name: "V".repeat(60) },
      "abc"
    );
    expect(xml).toContain(`<Name>${"V".repeat(41)}</Name>`);
  });

  it("omits the address block when there is no address", () => {
    expect(buildVendorModQbxml({ ...VENDOR, address: null }, "a")).not.toContain(
      "VendorAddress"
    );
  });
});

describe("EditSequence round trip", () => {
  const polled = (rs: Record<string, unknown>) => ({
    operation: { status: "completed", result: { QBXML: { QBXMLMsgsRs: rs } } },
  });

  it("asks QuickBooks for only the three fields it needs", () => {
    const xml = buildVendorEditSequenceQuery("80000A1B-1234567890");
    expect(xml).toContain("<ListID>80000A1B-1234567890</ListID>");
    expect(xml).toContain("<IncludeRetElement>EditSequence</IncludeRetElement>");
  });

  it("reads the EditSequence back", () => {
    const seq = parseVendorEditSequence(
      polled({
        VendorQueryRs: {
          statusCode: "0",
          VendorRet: { ListID: "80000A1B", EditSequence: "1785600000" },
        },
      })
    );
    expect(seq).toBe("1785600000");
  });

  it("reads it from a single-element array too", () => {
    expect(
      parseVendorEditSequence(
        polled({
          VendorQueryRs: {
            statusCode: "0",
            VendorRet: [{ EditSequence: "999" }],
          },
        })
      )
    ).toBe("999");
  });

  it("returns null instead of throwing on an unexpected payload", () => {
    expect(parseVendorEditSequence(undefined)).toBeNull();
    expect(parseVendorEditSequence(polled({}))).toBeNull();
    expect(
      parseVendorEditSequence(polled({ VendorQueryRs: { statusCode: "500" } }))
    ).toBeNull();
  });

  it("surfaces the status QuickBooks returned, whatever the response element is named", () => {
    expect(
      parseDirectQueryStatus(
        polled({
          StandardTermsAddRs: {
            statusCode: "3100",
            statusMessage: "The name is already in use.",
          },
        })
      )
    ).toMatchObject({ statusCode: "3100" });
    expect(parseDirectQueryStatus(undefined)).toEqual({
      statusCode: null,
      statusMessage: "",
      response: undefined,
    });
  });
});
