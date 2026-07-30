/**
 * The operator-facing sentence for a vendor bill that covers PART of its PO.
 *
 * This exists because the previous wording was actively wrong once a PO could
 * carry several regular bills: VB-1094 was told it was "missing $2,483.17"
 * against PO-1119, and that figure was VB-1076's contents to the cent. It also
 * prescribed "Update From…", which cannot repair a bill that is correct.
 */

import {
  describeDrift,
  type BillDrift,
} from "../../lib/china-finance/bill-drift";

function drift(over: Partial<BillDrift> = {}): BillDrift {
  return {
    vendor_bill_id: "vb_1",
    vendor_bill_number: "VB-1094",
    kind: "po_lines",
    delta_cents: -248317,
    bill_total_cents: 367436,
    expected_cents: 615753,
    source_label: "PO-1119",
    on_confirmed_wire: false,
    lines: [],
    severity: "info",
    po_qty: 10,
    bill_qty: 8,
    siblings: [{ number: "VB-1076", qty: 2 }],
    ...over,
  };
}

describe("describeDrift — partial bill awaiting receipts", () => {
  it("accounts for the PO's units instead of calling the bill broken", () => {
    const message = describeDrift(drift());
    expect(message).toBe(
      "This bill covers 8 of the 10 units on PO-1119. " +
        "The other 2 units are on bill VB-1076. " +
        "Check it against the vendor's invoice — quantities are only verified " +
        "once the goods arrive and you attach the item receipt with “Update From…”."
    );
  });

  it("gives the rest of the order its own sentence, not a dash fragment", () => {
    // "— 2 units on VB-1076 and 3 on VB-1097" left the reader to work out what
    // the clause was attached to, and never said the word "bill".
    const message = describeDrift(drift());
    // The clause about the other bills must be a sentence of its own, starting
    // after the first full stop — not hung off the covered count with a dash.
    const [first] = message.split(". ");
    expect(first).toBe("This bill covers 8 of the 10 units on PO-1119");
    expect(first).not.toContain("—");
    expect(message).toContain("The other 2 units are on bill VB-1076.");
  });

  it("states each sibling's own quantity, never a lump sum", () => {
    // Three bills on one PO is the case that exposed this: "5 units are on
    // VB-1097, VB-1076" named both documents while hiding which held what.
    const message = describeDrift(drift({
      vendor_bill_number: "VB-1094",
      bill_qty: 5,
      po_qty: 10,
      siblings: [{ number: "VB-1076", qty: 2 }, { number: "VB-1097", qty: 3 }],
    }));
    expect(message).toContain(
      "The other 5 units are split across bill VB-1076 with 2 units and bill VB-1097 with 3 units."
    );
    expect(message).not.toContain("5 units are on VB");
  });

  it("reads as a list once there are three or more siblings", () => {
    const message = describeDrift(drift({
      bill_qty: 1,
      po_qty: 10,
      siblings: [
        { number: "VB-1076", qty: 2 },
        { number: "VB-1097", qty: 3 },
        { number: "VB-1101", qty: 4 },
      ],
    }));
    expect(message).toContain(
      "split across bill VB-1076 with 2 units, bill VB-1097 with 3 units and bill VB-1101 with 4 units."
    );
  });

  it("drops a sibling that holds nothing", () => {
    // A bill zeroed out entirely is still an active row on the PO; naming it
    // with "0 on VB-####" is noise, not information.
    const message = describeDrift(drift({
      bill_qty: 8,
      siblings: [{ number: "VB-1076", qty: 2 }, { number: "VB-1200", qty: 0 }],
    }));
    expect(message).toContain("The other 2 units are on bill VB-1076.");
    expect(message).not.toContain("VB-1200");
  });

  it("never reports the sibling's contents as a shortfall", () => {
    const message = describeDrift(drift());
    expect(message).not.toContain("missing");
    expect(message).not.toContain("$2,483.17");
    expect(message).not.toContain("bring it back in line");
  });

  it("does not claim the bill is correct — only the vendor invoice says that", () => {
    // A partial bill that lost a line by accident looks exactly like one that
    // is partial on purpose. Asserting "nothing to fix" would be a verdict
    // this system has no evidence for; it can only report and defer.
    const message = describeDrift(drift());
    expect(message).not.toContain("Nothing to fix");
    expect(message).toContain("Check it against the vendor's invoice");
    expect(message).toContain("only verified once the goods arrive");
  });

  it("agrees in number with the UNIT count, not the bill count", () => {
    // An earlier draft pluralised off how many sibling bills there were, so a
    // single bill holding 8 units read "8 units is".
    expect(describeDrift(drift({ po_qty: 9, bill_qty: 8, siblings: [{ number: "VB-1076", qty: 1 }] })))
      .toContain("The other 1 unit is on bill VB-1076.");
    expect(describeDrift(drift({ po_qty: 16, bill_qty: 8, siblings: [{ number: "VB-1076", qty: 8 }] })))
      .toContain("The other 8 units are on bill VB-1076.");
  });

  it("names every sibling holding part of the order, with its own share", () => {
    const message = describeDrift(drift({
      bill_qty: 4,
      po_qty: 10,
      siblings: [{ number: "VB-1076", qty: 2 }, { number: "VB-1101", qty: 4 }],
    }));
    expect(message).toContain(
      "bill VB-1076 with 2 units and bill VB-1101 with 4 units"
    );
  });

  it("says how much of the PO no bill has claimed yet", () => {
    const message = describeDrift(drift({ bill_qty: 3, siblings: [] }));
    expect(message).toContain("This bill covers 3 of the 10 units on PO-1119.");
    expect(message).toContain("The other 7 units are not on any bill yet.");
  });

  it("omits the leftover clause when the PO is fully covered", () => {
    expect(describeDrift(drift())).not.toContain("not on any bill yet");
  });
});

describe("describeDrift — real drift still reads as a problem", () => {
  it("a bill claiming MORE than its PO keeps the warning wording", () => {
    const message = describeDrift(drift({
      severity: "warning",
      delta_cents: 50000,
    }));
    expect(message).toContain("claims $500.00 more than PO-1119");
    expect(message).toContain("Update From…");
  });

  it("a paid bill still points at the credit-note route", () => {
    const message = describeDrift(drift({
      severity: "warning",
      delta_cents: -50000,
      on_confirmed_wire: true,
    }));
    expect(message).toContain("is missing $500.00 against PO-1119");
    expect(message).toContain("supervisor PIN");
  });
});
