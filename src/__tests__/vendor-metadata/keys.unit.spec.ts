import {
  readVendorFullName,
  readVendorListId,
  vendorFullNameSql,
  vendorListIdSql,
  vendorMetadataPatch,
} from "../../lib/vendor-metadata/keys";

/**
 * The vendor metadata pair, post-contract.
 *
 * `vendor_full_name` / `vendor_list_id` are the only spelling — the old
 * `qb_vendor_*` names were dropped from the database on 2026-08-12 and there is
 * deliberately no fallback left. These specs pin that: a reader must NOT
 * resurrect the old name, because doing so would hide a writer that never got
 * migrated behind a value that happens to still be correct.
 *
 * They also pin what the POS edit workflows depend on: `undefined` survives so
 * `pruneUndefined` still drops untouched fields, and `null` is emitted so a
 * cleared vendor actually clears.
 */
describe("vendor metadata keys — reads", () => {
  it("reads the pair", () => {
    const meta = { vendor_full_name: "Luxury LED LLC", vendor_list_id: "LID-1" };
    expect(readVendorFullName(meta)).toBe("Luxury LED LLC");
    expect(readVendorListId(meta)).toBe("LID-1");
  });

  it("does NOT fall back to the dropped qb_ spelling", () => {
    const meta = {
      qb_vendor_full_name: "HK HELIAN OPTOELECTRONICS CO., LIMITED",
      qb_vendor_list_id: "OLD-ID",
    };
    expect(readVendorFullName(meta)).toBeNull();
    expect(readVendorListId(meta)).toBeNull();
  });

  it("treats blank and non-string values as absent, never as a vendor named ''", () => {
    expect(readVendorFullName({ vendor_full_name: "   " })).toBeNull();
    expect(readVendorFullName({ vendor_full_name: null })).toBeNull();
    expect(readVendorFullName({ vendor_full_name: 42 })).toBeNull();
    expect(readVendorFullName({})).toBeNull();
    expect(readVendorFullName(null)).toBeNull();
  });
});

describe("vendor metadata keys — writes", () => {
  it("emits the pair and nothing else", () => {
    expect(vendorMetadataPatch("Luxury LED LLC", "LID-1")).toEqual({
      vendor_full_name: "Luxury LED LLC",
      vendor_list_id: "LID-1",
    });
  });

  it("never writes the dropped qb_ spelling back", () => {
    const patch = vendorMetadataPatch("Luxury LED LLC", "LID-1");
    expect(Object.keys(patch)).not.toContain("qb_vendor_full_name");
    expect(Object.keys(patch)).not.toContain("qb_vendor_list_id");
  });

  it("preserves undefined so pruneUndefined still drops untouched fields", () => {
    const patch = vendorMetadataPatch(undefined, "LID-1");
    expect(patch.vendor_full_name).toBeUndefined();
    expect(patch.vendor_list_id).toBe("LID-1");
  });

  it("emits null when clearing — omitting a key would keep the old value", () => {
    expect(vendorMetadataPatch(null, null)).toEqual({
      vendor_full_name: null,
      vendor_list_id: null,
    });
  });
});

describe("vendor metadata keys — SQL", () => {
  it("emits no bind placeholder — a `?` would shift every caller's binding count", () => {
    expect(vendorFullNameSql("p")).not.toContain("?");
    expect(vendorListIdSql("p")).not.toContain("?");
  });

  it("does not reference the dropped qb_ spelling", () => {
    expect(vendorFullNameSql("p")).not.toContain("qb_vendor_full_name");
    expect(vendorListIdSql("p")).not.toContain("qb_vendor_list_id");
  });

  it("honours the alias it is given", () => {
    expect(vendorListIdSql("prod")).toContain("prod.metadata->>'vendor_list_id'");
    expect(vendorFullNameSql("p")).toContain("p.metadata->>'vendor_full_name'");
  });
});
